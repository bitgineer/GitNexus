import { parentPort } from 'node:worker_threads';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { createRequire } from 'node:module';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { getProvider } from '../languages/index.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from '../constants.js';

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: any = null;
try { Swift = _require('tree-sitter-swift'); } catch {}

// tree-sitter-dart is an optionalDependency — may not be installed
let Dart: any = null;
try { Dart = _require('tree-sitter-dart'); } catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: any = null;
try { Kotlin = _require('tree-sitter-kotlin'); } catch {}
import { getLanguageFromFilename } from '../utils/language-detection.js';
import {
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  getDefinitionNodeFromCaptures,
  findEnclosingClassId,
  getLabelFromCaptures,
  extractMethodSignature,
  findDescendant,
  extractStringContent,
  type SyntaxNode,
} from '../utils/ast-helpers.js';
import {
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
  type MixedChainStep,
} from '../utils/call-analysis.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { JSX_EXTRA_QUERIES } from '../tree-sitter-queries.js';
import { generateId } from '../../../lib/utils.js';
import { preprocessImportPath } from '../import-processor.js';
import type { NamedBinding } from '../named-bindings/types.js';
import type { NodeLabel } from '../../graph/types.js';
import type { FieldInfo, FieldExtractorContext } from '../field-types.js';
import { CLASS_CONTAINER_TYPES } from '../utils/ast-helpers.js';

// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: SupportedLanguages;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    parameterCount?: number;
    requiredParameterCount?: number;
    returnType?: string;
    // Field/property metadata (populated by FieldExtractor)
    declaredType?: string;
    visibility?: string;
    isStatic?: boolean;
    isReadonly?: boolean;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD' | 'HAS_PROPERTY';
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: NodeLabel;
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: NamedBinding[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
   * Steps are ordered base-first (innermost to outermost). Examples:
   *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
   *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
   *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverMixedChain?: MixedChainStep[];
  /** Whether this call is inside an await expression */
  isAwaited?: boolean;
}

export interface ExtractedAssignment {
  filePath: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** Receiver text (e.g., 'user' from user.address = value) */
  receiverText: string;
  /** Property name being written (e.g., 'address') */
  propertyName: string;
  /** Resolved type name of the receiver if available from TypeEnv */
  receiverTypeName?: string;
}

export interface ExtractedHeritage {
  filePath: string;
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' | 'include' | 'extend' | 'prepend' */
  kind: string;
}

export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
}

export interface ExtractedFetchCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

export interface ExtractedDecoratorRoute {
  filePath: string;
  routePath: string;
  httpMethod: string;
  decoratorName: string;
  lineNumber: number;
}

export interface ExtractedToolDef {
  filePath: string;
  toolName: string;
  description: string;
  lineNumber: number;
}

export interface ExtractedORMQuery {
  filePath: string;
  orm: 'prisma' | 'supabase';
  model: string;
  method: string;
  lineNumber: number;
}

export interface ExtractedChannel {
  /** File containing this channel reference */
  filePath: string;
  /** The string-literal channel/event name (e.g., 'user-created', 'data-sync') */
  channelName: string;
  /** Whether this side sends or listens */
  role: 'producer' | 'consumer';
  /** Transport mechanism that matched */
  transport: 'electron-ipc' | 'socket.io' | 'event-emitter' | 'csharp-event' | 'csharp-emitter';
  /** ID of the enclosing function/method that contains this channel reference */
  enclosingSymbolId: string;
  /** Source line number */
  lineNumber: number;
}

export interface ExtractedEventRef {
  filePath: string;
  /** The event field name (e.g., 'OnConnected', 'TimerTick') */
  eventName: string;
  /** Whether this is a fire (?.Invoke) or subscribe (+=) site */
  role: 'fire' | 'subscribe';
  /** ID of the enclosing function/method */
  enclosingSymbolId: string;
  /** The receiver text for scoping (e.g., '_socket', 'f') — only for subscribe sites */
  receiverText?: string;
  /** The handler name (for subscribe sites: the function assigned via +=) */
  handlerName?: string;
  lineNumber: number;
}

export interface ExtractedOverride {
  filePath: string;
  /** Name of the method with override modifier */
  methodName: string;
  /** Node ID of the override method */
  methodNodeId: string;
  /** Node ID of the enclosing class */
  enclosingClassId: string;
}

export interface ExtractedExtensionMethod {
  filePath: string;
  methodName: string;
  methodNodeId: string;
  /** The type being extended (e.g., 'IRepository', 'Vector3') */
  extendedTypeName: string;
}

export interface ExtractedContextRef {
  filePath: string;
  /** The context variable name (e.g., 'ThemeContext', 'AuthContext') */
  contextName: string;
  /** Whether this is a provider (<Ctx.Provider>) or consumer (useContext(Ctx)) */
  role: 'provider' | 'consumer';
  /** ID of the enclosing function/component */
  enclosingSymbolId: string;
  lineNumber: number;
}

/** Per-file const value map: varName → string literal value, for same-file const resolution */
export interface FileConstValues {
  filePath: string;
  /** [constName, stringValue] pairs — e.g., ['EVENT_USER_LOGIN', 'UserLogin'] */
  consts: [string, string][];
  /** [objectName, [propName, stringValue][]] — e.g., ['Events', [['USER_JOINED', 'user-joined']]] */
  objectProps: [string, [string, string][]][];
}
/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

/** File-scope type bindings from TypeEnv fixpoint — used for cross-file ExportedTypeMap. */
export interface FileTypeEnvBindings {
  filePath: string;
  /** [varName, typeName] pairs from file scope (scope = '') */
  bindings: [string, string][];
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  channels: ExtractedChannel[];
  eventRefs: ExtractedEventRef[];
  overrides: ExtractedOverride[];
  extensionMethods: ExtractedExtensionMethod[];
  contextRefs: ExtractedContextRef[];
  constValues: FileConstValues[];
  constructorBindings: FileConstructorBindings[];
  /** File-scope type bindings from TypeEnv fixpoint for exported symbol collection. */
  typeEnvBindings: FileTypeEnvBindings[];
  skippedLanguages: Record<string, number>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const languageMap: Record<string, any> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Ruby]: Ruby,
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// ============================================================================
// Per-file O(1) memoization — avoids repeated parent-chain walks per symbol.
// Three bare Maps cleared at file boundaries. Map.get() returns undefined for
// missing keys, so `cached !== undefined` distinguishes "not computed" from
// a stored null (enclosing class/function not found = top-level).
// ============================================================================

const classIdCache = new Map<any, string | null>();
const functionIdCache = new Map<any, string | null>();
const exportCache = new Map<any, boolean>();

const clearCaches = (): void => { classIdCache.clear(); functionIdCache.clear(); exportCache.clear(); fieldInfoCache.clear(); namespaceCache.clear(); };

// ============================================================================
// FieldExtractor cache — extract field metadata once per class, reuse for each property.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const fieldInfoCache = new Map<number, Map<string, FieldInfo>>();

/**
 * Walk up from a definition node to find the nearest enclosing class/struct/interface
 * AST node. Returns the SyntaxNode itself (not an ID) for passing to FieldExtractor.
 */
function findEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Minimal no-op SymbolTable stub for FieldExtractorContext in the worker.
 * Field extraction only uses symbolTable.lookupExactAll for optional type resolution —
 * returning [] causes the extractor to use the raw type string, which is fine for us.
 */
const NOOP_SYMBOL_TABLE: any = {
  lookupExactAll: () => [],
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
};

/**
 * Get (or extract and cache) field info for a class node.
 * Returns a name→FieldInfo map, or undefined if the provider has no field extractor
 * or the class yielded no fields.
 */
function getFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = fieldInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.fieldExtractor.extract(classNode, context);
  if (!result?.fields?.length) return undefined;

  cached = new Map<string, FieldInfo>();
  for (const field of result.fields) {
    cached.set(field.name, field);
  }
  fieldInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// Enclosing namespace detection (for C# partial class unification)
// ============================================================================

const namespaceCache = new Map<any, string | null>();

/** Walk up AST (or check siblings) to find the enclosing C# namespace.
 *  Handles both block-scoped (`namespace N { class C {} }`) and
 *  file-scoped (`namespace N; class C {}`) declarations. */
const findEnclosingNamespace = (node: any): string | null => {
  const cached = namespaceCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    // Block-scoped: class is inside namespace_declaration > declaration_list
    if (current.type === 'namespace_declaration') {
      const nameNode = current.childForFieldName?.('name')
        ?? current.children?.find((c: any) => c.type === 'qualified_name' || c.type === 'identifier');
      const ns = nameNode?.text ?? null;
      namespaceCache.set(node, ns);
      return ns;
    }
    current = current.parent;
  }

  // File-scoped: file_scoped_namespace_declaration is a sibling at compilation_unit level
  const root = node.tree?.rootNode;
  if (root) {
    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i);
      if (child?.type === 'file_scoped_namespace_declaration') {
        const nameNode = child.childForFieldName?.('name')
          ?? child.children?.find((c: any) => c.type === 'qualified_name' || c.type === 'identifier');
        const ns = nameNode?.text ?? null;
        namespaceCache.set(node, ns);
        return ns;
      }
    }
  }

  namespaceCache.set(node, null);
  return null;
};

// ============================================================================
// Enclosing function detection (for call extraction) — cached
// ============================================================================

import type { LanguageProvider } from '../language-provider.js';

/** Walk up AST to find enclosing function, return its generateId or null for top-level.
 *  Applies provider.labelOverride so the label matches the definition phase (single source of truth). */
const findEnclosingFunctionId = (node: any, filePath: string, provider: LanguageProvider): string | null => {
  const cached = functionIdCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);
      if (funcName) {
        // Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
        // null means "skip as definition" — keep original label for scope identification.
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        const result = generateId(finalLabel, `${filePath}:${funcName}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        let finalLabel: NodeLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling, finalLabel);
          if (override !== null) finalLabel = override;
        }
        const result = generateId(finalLabel, `${filePath}:${customResult.funcName}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    current = current.parent;
  }
  functionIdCache.set(node, null);
  return null;
};

/** Cached wrapper for findEnclosingClassId — avoids repeated parent walks. */
const cachedFindEnclosingClassId = (node: any, filePath: string): string | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;

  const result = findEnclosingClassId(node, filePath);
  classIdCache.set(node, result);
  return result;
};

/** Cached wrapper for export checking — avoids repeated parent walks per symbol. */
const cachedExportCheck = (checker: (node: any, name: string) => boolean, node: any, name: string): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;

  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

// Label detection moved to shared getLabelFromCaptures in utils.ts

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js


// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (files: ParseWorkerInput[], onProgress?: (filesProcessed: number) => void): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
    calls: [],
    assignments: [],
    heritage: [],
    routes: [],
    fetchCalls: [],
    decoratorRoutes: [],
    toolDefs: [],
    ormQueries: [],
    channels: [],
    eventRefs: [],
    overrides: [],
    extensionMethods: [],
    contextRefs: [],
    constValues: [],
    constructorBindings: [],
    typeEnvBindings: [],
    skippedLanguages: {},
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = 100; // report every 100 files

  const onFileProcessed = onProgress ? () => {
    totalProcessed++;
    if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
      lastReported = totalProcessed;
      onProgress(totalProcessed);
    }
  } : undefined;

  for (const [language, langFiles] of byLanguage) {
    const provider = getProvider(language);
    const queryString = provider.treeSitterQueries;
    if (!queryString) continue;

    // Track if we need to handle tsx separately
    const tsxFiles: ParseWorkerInput[] = [];
    const regularFiles: ParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      regularFiles.push(...langFiles);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + regularFiles.length;
      }
    }

    // Process tsx files separately (different grammar, with JSX-specific queries)
    if (tsxFiles.length > 0) {
      if (isLanguageAvailable(language, tsxFiles[0].path)) {
        try {
          setLanguage(language, tsxFiles[0].path);
          const tsxQueryString = queryString + '\n' + (JSX_EXTRA_QUERIES || '');
          processFileGroup(tsxFiles, language, tsxQueryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  // ── SCSS/CSS class name extraction (regex-based, no tree-sitter) ──────────
  // Extract CSS class names from .scss/.css files as CodeElement nodes.
  const SCSS_CLASS_RE = /^\s*[.&]([a-zA-Z_][\w-]*)\s*[,{&:\s]/gm;
  const SCSS_SKIP_RE = /^\s*[@$%\/\\]/;
  for (const f of files) {
    if (!f.path.endsWith('.scss') && !f.path.endsWith('.css')) continue;

    const fileId = generateId('File', f.path);
    const seenClasses = new Set<string>();

    for (const line of f.content.split('\n')) {
      if (SCSS_SKIP_RE.test(line)) continue;
      SCSS_CLASS_RE.lastIndex = 0;
      let m;
      while ((m = SCSS_CLASS_RE.exec(line)) !== null) {
        const cls = m[1];
        if (seenClasses.has(cls)) continue;
        seenClasses.add(cls);

        const nodeId = generateId('CodeElement', `${f.path}:.${cls}`);
        result.nodes.push({
          id: nodeId,
          label: 'CodeElement',
          properties: { name: `.${cls}`, filePath: f.path, startLine: 0, endLine: 0, language: SupportedLanguages.TypeScript, isExported: false },
        });
        result.relationships.push({
          id: generateId('DEFINES', `${fileId}->${nodeId}`),
          sourceId: fileId, targetId: nodeId, type: 'DEFINES', confidence: 1.0, reason: 'scss-class',
        });
      }
    }
    result.fileCount++;
    onFileProcessed?.();
  }

  return result;
};

// ============================================================================
// Laravel Route Extraction (procedural AST walk)
// ============================================================================

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

const ROUTE_HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);

// Express/Hono method names that register routes
const EXPRESS_ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'route']);

// HTTP client methods that are ONLY used by clients, not Express route registration.
// Methods like get/post/put/delete/patch overlap with Express — those are captured by
// the express_route handler as route definitions, not consumers. The fetch() global
// function is captured separately by the route.fetch query.
const HTTP_CLIENT_ONLY_METHODS = new Set(['head', 'options', 'request', 'ajax']);

// Decorator names that indicate HTTP route handlers (NestJS, Flask, FastAPI, Spring)
const ROUTE_DECORATOR_NAMES = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch', 'Route',
  'get', 'post', 'put', 'delete', 'patch', 'route',
  'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping',
]);

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: any): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
function getCallMethodName(node: any): string | null {
  const nameNode = node.childForFieldName?.('name') ??
    node.children?.find((c: any) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
function getArguments(node: any): any {
  return node.children?.find((c: any) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
function findClosureBody(argsNode: any): any | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' ||
            inner.type === 'arrow_function') {
          return inner.childForFieldName?.('body') ??
            inner.children?.find((c: any) => c.type === 'compound_statement');
        }
      }
    }
    if (child.type === 'anonymous_function' ||
        child.type === 'arrow_function') {
      return child.childForFieldName?.('body') ??
        child.children?.find((c: any) => c.type === 'compound_statement');
    }
  }
  return null;
}

/** Extract first string argument from arguments node */
function extractFirstStringArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      return extractStringContent(target);
    }
  }
  return null;
}

/** Extract middleware from arguments — handles string or array */
function extractMiddlewareArg(argsNode: any): string[] {
  if (!argsNode) return [];
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      const val = extractStringContent(target);
      return val ? [val] : [];
    }
    if (target.type === 'array_creation_expression') {
      const items: string[] = [];
      for (const el of target.children ?? []) {
        if (el.type === 'array_element_initializer') {
          const str = el.children?.find((c: any) => c.type === 'string' || c.type === 'encapsed_string');
          const val = str ? extractStringContent(str) : null;
          if (val) items.push(val);
        }
      }
      return items;
    }
  }
  return [];
}

/** Extract Controller::class from arguments */
function extractClassArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: any) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

/** Extract controller class name from arguments: [Controller::class, 'method'] or 'Controller@method' */
function extractControllerTarget(argsNode: any): { controller: string | null; method: string | null } {
  if (!argsNode) return { controller: null, method: null };

  const args: any[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') args.push(child.children?.[0]);
    else if (child.type !== '(' && child.type !== ')' && child.type !== ',') args.push(child);
  }

  // Second arg is the handler
  const handlerNode = args[1];
  if (!handlerNode) return { controller: null, method: null };

  // Array syntax: [UserController::class, 'index']
  if (handlerNode.type === 'array_creation_expression') {
    let controller: string | null = null;
    let method: string | null = null;
    const elements: any[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        controller = classAccess.children?.find((c: any) => c.type === 'name')?.text ?? null;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], 'string');
      method = str ? extractStringContent(str) : null;
    }
    return { controller, method };
  }

  // String syntax: 'UserController@index'
  if (handlerNode.type === 'string' || handlerNode.type === 'encapsed_string') {
    const text = extractStringContent(handlerNode);
    if (text?.includes('@')) {
      const [controller, method] = text.split('@');
      return { controller, method };
    }
  }

  // Class reference: UserController::class (invokable controller)
  if (handlerNode.type === 'class_constant_access_expression') {
    const controller = handlerNode.children?.find((c: any) => c.type === 'name')?.text ?? null;
    return { controller, method: '__invoke' };
  }

  return { controller: null, method: null };
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: any }[];
  terminalArgs: any;
  node: any;
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: any): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: any }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === 'member_call_expression') {
      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === 'scoped_call_expression') {
      const obj = current.childForFieldName?.('object') ?? current.children?.[0];
      if (obj?.text !== 'Route') return null;

      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse Route::group(['middleware' => ..., 'prefix' => ...], fn) array syntax */
function parseArrayGroupArgs(argsNode: any): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: any) => c.type === '=>');
        if (arrowIdx === -1) continue;
        const key = extractStringContent(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === 'middleware') {
          if (val?.type === 'string') {
            const s = extractStringContent(val);
            if (s) ctx.middleware.push(s);
          } else if (val?.type === 'array_creation_expression') {
            for (const item of val.children ?? []) {
              if (item.type === 'array_element_initializer') {
                const str = item.children?.find((c: any) => c.type === 'string');
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === 'prefix') {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            ctx.controller = val.children?.find((c: any) => c.type === 'name')?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

function extractLaravelRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): { middleware: string[]; prefix: string | null; controller: string | null } {
    const middleware: string[] = [];
    let prefix: string | null = null;
    let controller: string | null = null;
    for (const ctx of stack) {
      middleware.push(...ctx.middleware);
      if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, '/') : ctx.prefix;
      if (ctx.controller) controller = ctx.controller;
    }
    return { middleware, prefix, controller };
  }

  function emitRoute(
    httpMethod: string,
    argsNode: any,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: any }[],
  ) {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware') effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
      if (attr.method === 'prefix') {
        const p = extractFirstStringArg(attr.argsNode);
        if (p) effective.prefix = effective.prefix ? `${effective.prefix}/${p}` : p;
      }
      if (attr.method === 'controller') {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
    }

    const routePath = extractFirstStringArg(argsNode);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod)) {
      const target = extractControllerTarget(argsNode);
      const actions = httpMethod === 'apiResource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      for (const action of actions) {
        routes.push({
          filePath, httpMethod, routePath,
          controllerName: target.controller ?? effective.controller,
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    } else {
      const target = extractControllerTarget(argsNode);
      routes.push({
        filePath, httpMethod, routePath,
        controllerName: target.controller ?? effective.controller,
        methodName: target.method,
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
      });
    }
  }

  function walk(node: any, groupStack: RouteGroupContext[]) {
    // Case 1: Simple Route::get(...), Route::post(...), etc.
    if (isRouteStaticCall(node)) {
      const method = getCallMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(method, getArguments(node), node.startPosition.row, groupStack, []);
        return;
      }
      if (method === 'group') {
        const argsNode = getArguments(node);
        const groupCtx = parseArrayGroupArgs(argsNode);
        const body = findClosureBody(argsNode);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
    }

    // Case 2: Fluent chain — Route::middleware(...)->group(...) or Route::middleware(...)->get(...)
    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === 'group') {
        const groupCtx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
        for (const attr of chain.attributes) {
          if (attr.method === 'middleware') groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
          if (attr.method === 'prefix') groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'controller') groupCtx.controller = extractClassArg(attr.argsNode);
        }
        const body = findClosureBody(chain.terminalArgs);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
      if (ROUTE_HTTP_METHODS.has(chain.terminalMethod) || ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)) {
        emitRoute(chain.terminalMethod, chain.terminalArgs, node.startPosition.row, groupStack, chain.attributes);
        return;
      }
    }

    // Default: recurse into children
    walkChildren(node, groupStack);
  }

  function walkChildren(node: any, groupStack: RouteGroupContext[]) {
    for (const child of node.children ?? []) {
      walk(child, groupStack);
    }
  }

  walk(tree.rootNode, []);
  return routes;
}

// ============================================================================
// ORM Query Detection (Prisma + Supabase)
// ============================================================================

const PRISMA_QUERY_RE = /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;
const SUPABASE_QUERY_RE = /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

/**
 * Extract ORM query calls from file content via regex.
 * Appends results to the provided array (avoids allocation when no matches).
 */
export function extractORMQueries(filePath: string, content: string, out: ExtractedORMQuery[]): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  if (!hasPrisma && !hasSupabase) return;

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }
}

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: any;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
    if (parentPort) {
      parentPort.postMessage({ type: 'warning', message });
    } else {
      console.warn(message);
    }
    return;
  }

  for (const file of files) {
    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    clearCaches(); // Reset memoization before each new file

    let tree;
    try {
      tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
    } catch (err) {
      console.warn(`Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch (err) {
      console.warn(`Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Pre-pass: extract heritage from query matches to build parentMap for buildTypeEnv.
    // Heritage edges (EXTENDS/IMPLEMENTS) are created by heritage-processor which runs
    // in PARALLEL with call-processor, so the graph edges don't exist when buildTypeEnv
    // runs. This pre-pass makes parent class information available for type resolution.
    const fileParentMap = new Map<string, string[]>();
    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className: string = captureMap['heritage.class'].text;
        const parentName: string = captureMap['heritage.extends'].text;
        // Skip Go named fields (only anonymous fields are struct embedding)
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name')) continue;
        let parents = fileParentMap.get(className);
        if (!parents) { parents = []; fileParentMap.set(className, parents); }
        if (!parents.includes(parentName)) parents.push(parentName);
      }
    }

    // Pre-pass: collect const string values and object literal string maps for channel name resolution.
    // Collects: const FOO = 'bar' → constValueMap['FOO'] = 'bar'
    //           const OBJ = { KEY: 'val' } → objectValueMap['OBJ']['KEY'] = 'val'
    const constValueMap = new Map<string, string>();
    const objectValueMap = new Map<string, Map<string, string>>();
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      // Walk top-level lexical_declaration nodes directly (not via query matches) to find:
      //   const FOO = 'bar'  →  constValueMap['FOO'] = 'bar'
      //   const OBJ = { KEY: 'val' }  →  objectValueMap['OBJ']['KEY'] = 'val'
      const root = tree.rootNode;
      for (let i = 0; i < root.childCount; i++) {
        let declNode = root.child(i);
        // Unwrap export_statement → declaration
        if (declNode?.type === 'export_statement') {
          declNode = declNode.childForFieldName?.('declaration') ?? declNode.namedChildren?.find((c: any) => c.type === 'lexical_declaration');
        }
        if (declNode?.type !== 'lexical_declaration') continue;
        for (let j = 0; j < declNode.namedChildCount; j++) {
          const varDecl = declNode.namedChild(j);
          if (varDecl?.type !== 'variable_declarator') continue;
          const nameNode = varDecl.childForFieldName?.('name');
          const valueNode = varDecl.childForFieldName?.('value');
          if (!nameNode || !valueNode || nameNode.type !== 'identifier') continue;
          const varName = nameNode.text;
          // Simple string: const FOO = 'bar'
          if (valueNode.type === 'string') {
            const frag = valueNode.namedChildren?.find((c: any) => c.type === 'string_fragment');
            if (frag) constValueMap.set(varName, frag.text);
          }
          // Object literal: const OBJ = { KEY: 'val', KEY2: 'val2' }
          if (valueNode.type === 'object') {
            const objMap = new Map<string, string>();
            for (let k = 0; k < valueNode.namedChildCount; k++) {
              const pair = valueNode.namedChild(k);
              if (pair?.type === 'pair') {
                const key = pair.childForFieldName?.('key');
                const val = pair.childForFieldName?.('value');
                if (key && val?.type === 'string') {
                  const frag = val.namedChildren?.find((c: any) => c.type === 'string_fragment');
                  if (frag) objMap.set(key.text, frag.text);
                }
              }
            }
            if (objMap.size > 0) objectValueMap.set(varName, objMap);
          }

          // Destructure: const { A, B } = OBJ — resolve each prop against objectValueMap
          if (nameNode.type === 'object_pattern' && valueNode.type === 'identifier') {
            const srcObjName = valueNode.text;
            const srcMap = objectValueMap.get(srcObjName);
            for (let di = 0; di < nameNode.namedChildCount; di++) {
              const prop = nameNode.namedChild(di);
              if (prop?.type === 'shorthand_property_identifier_pattern') {
                const propName = prop.text;
                if (srcMap?.has(propName)) {
                  // Same-file: resolve immediately
                  constValueMap.set(propName, srcMap.get(propName)!);
                } else {
                  // Cross-file: store placeholder for post-parse resolution
                  constValueMap.set(propName, `@${srcObjName}.${propName}`);
                }
              }
            }
          }
        }
      }
      // Serialize const/object maps for cross-file resolution
      if (constValueMap.size > 0 || objectValueMap.size > 0) {
        const consts: [string, string][] = [];
        for (const [k, v] of constValueMap) consts.push([k, v]);
        const objectProps: [string, [string, string][]][] = [];
        for (const [objName, props] of objectValueMap) {
          const pairs: [string, string][] = [];
          for (const [k, v] of props) pairs.push([k, v]);
          objectProps.push([objName, pairs]);
        }
        result.constValues.push({ filePath: file.path, consts, objectProps });
      }
    }

    // C# const field collection: private const string FIELD = "value" → constValueMap
    if (language === SupportedLanguages.CSharp) {
      const walkForConsts = (node: any): void => {
        if (!node) return;
        if (node.type === 'field_declaration') {
          let isConst = false;
          for (let i = 0; i < node.childCount; i++) {
            const ch = node.child(i);
            if (ch?.type === 'modifier' && ch.text === 'const') { isConst = true; break; }
            if (ch?.isNamed && ch.type !== 'modifier') break;
          }
          if (isConst) {
            const varDecl = node.namedChildren?.find((c: any) => c.type === 'variable_declaration');
            if (varDecl) {
              for (let j = 0; j < varDecl.namedChildCount; j++) {
                const declarator = varDecl.namedChild(j);
                if (declarator?.type === 'variable_declarator') {
                  const nameNode = declarator.namedChildren?.find((c: any) => c.type === 'identifier');
                  const literalNode = declarator.namedChildren?.find((c: any) => c.type === 'string_literal');
                  if (nameNode && literalNode) {
                    const contentNode = literalNode.namedChildren?.find((c: any) =>
                      c.type === 'string_literal_content' || c.type === 'string_fragment');
                    if (contentNode) {
                      constValueMap.set(nameNode.text, contentNode.text);
                    } else {
                      const raw = literalNode.text;
                      const val = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
                      if (val) constValueMap.set(nameNode.text, val);
                    }
                  }
                }
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walkForConsts(node.child(i));
      };
      walkForConsts(tree.rootNode);

      // Serialize for cross-file resolution
      if (constValueMap.size > 0) {
        const consts: [string, string][] = [];
        for (const [k, v] of constValueMap) consts.push([k, v]);
        result.constValues.push({ filePath: file.path, consts, objectProps: [] });
      }
    }

    // Build per-file type environment + constructor bindings in a single AST walk.
    // Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
    const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
    const provider = getProvider(language);
    const typeEnv = buildTypeEnv(tree, language, { parentMap, enclosingFunctionFinder: provider?.enclosingFunctionFinder });
    const callRouter = provider.callRouter;

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({ filePath: file.path, bindings: [...typeEnv.constructorBindings] });
    }

    // Extract file-scope bindings for ExportedTypeMap (closes worker/sequential quality gap).
    // Sequential path uses collectExportedBindings(typeEnv) directly; worker path serializes
    // these bindings so the main thread can merge them into ExportedTypeMap.
    const fileScope = typeEnv.fileScope();
    if (fileScope.size > 0) {
      const bindings: [string, string][] = [];
      for (const [name, type] of fileScope) bindings.push([name, type]);
      result.typeEnvBindings.push({ filePath: file.path, bindings });
    }

    // Per-file map: decorator end-line → decorator info, for associating with definitions
    const fileDecorators = new Map<number, { name: string; arg?: string; isTool?: boolean }>();

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract import paths before skipping
      if (captureMap['import'] && captureMap['import.source']) {
        const rawImportPath = preprocessImportPath(captureMap['import.source'].text, captureMap['import'], provider);
        if (!rawImportPath) continue;
        const extractor = provider.namedBindingExtractor;
        const namedBindings = extractor ? extractor(captureMap['import']) : undefined;
        result.imports.push({
          filePath: file.path,
          rawImportPath,
          language: language,
          ...(namedBindings ? { namedBindings } : {}),
        });
        continue;
      }

      // Extract assignment sites (field write access)
      if (captureMap['assignment'] && captureMap['assignment.receiver'] && captureMap['assignment.property']) {
        const receiverText = captureMap['assignment.receiver'].text;
        const propertyName = captureMap['assignment.property'].text;
        if (receiverText && propertyName) {
          const srcId = findEnclosingFunctionId(captureMap['assignment'], file.path, provider)
            || generateId('File', file.path);
          let receiverTypeName: string | undefined;
          if (typeEnv) {
            receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']) ?? undefined;
          }
          result.assignments.push({
            filePath: file.path,
            sourceId: srcId,
            receiverText,
            propertyName,
            ...(receiverTypeName ? { receiverTypeName } : {}),
          });
        }
        if (!captureMap['call']) continue;
      }

      // Store decorator metadata for later association with definitions
      if (captureMap['decorator'] && captureMap['decorator.name']) {
        const decoratorName = captureMap['decorator.name'].text;
        const decoratorArg = captureMap['decorator.arg']?.text;
        const decoratorNode = captureMap['decorator'];
        // Store by the decorator's end line — the definition follows immediately after
        fileDecorators.set(decoratorNode.endPosition.row, { name: decoratorName, arg: decoratorArg });

        if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
          const routePath = decoratorArg || '';
          const method = decoratorName.replace('Mapping', '').toUpperCase();
          const httpMethod = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? method : 'GET';
          result.decoratorRoutes.push({
            filePath: file.path,
            routePath,
            httpMethod,
            decoratorName,
            lineNumber: decoratorNode.startPosition.row,
          });
        }
        // MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
        if (decoratorName === 'tool') {
          // Re-store with isTool flag for the definition handler
          fileDecorators.set(decoratorNode.endPosition.row, { name: decoratorName, arg: decoratorArg, isTool: true });
        }
        continue;
      }

      // ── Extract React Context references (Provider → Consumer data flow) ──

      // useContext(ContextName) — consumer side
      if (captureMap['context.consumer'] && captureMap['context.consumed']) {
        const contextName = captureMap['context.consumed'].text;
        const enclosingId = findEnclosingFunctionId(captureMap['context.consumer'], file.path, provider) ?? generateId('File', file.path);
        result.contextRefs.push({
          filePath: file.path, contextName, role: 'consumer',
          enclosingSymbolId: enclosingId,
          lineNumber: captureMap['context.consumer'].startPosition.row,
        });
        continue;
      }

      // <Context.Provider> — provider side
      if (captureMap['context.provider'] && captureMap['context.provider.name']) {
        const contextName = captureMap['context.provider.name'].text;
        const enclosingId = findEnclosingFunctionId(captureMap['context.provider'], file.path, provider) ?? generateId('File', file.path);
        result.contextRefs.push({
          filePath: file.path, contextName, role: 'provider',
          enclosingSymbolId: enclosingId,
          lineNumber: captureMap['context.provider'].startPosition.row,
        });
        continue;
      }

      // ── Extract message channel references (Electron IPC, Socket.IO, EventEmitter) ──
      // MUST run before http_client/express_route — those broad patterns also match IPC calls

      // Electron IPC consumer: ipcMain.handle('channel', fn), ipcMain.on('channel', fn)
      if (captureMap['channel.consumer'] && captureMap['channel.name'] && captureMap['channel.method']) {
        const methodName = captureMap['channel.method'].text;
        if (methodName === 'handle' || methodName === 'on') {
          const channelName = captureMap['channel.name'].text;
          const enclosingId = findEnclosingFunctionId(captureMap['channel.consumer'], file.path, provider) ?? generateId('File', file.path);
          result.channels.push({
            filePath: file.path, channelName, role: 'consumer',
            transport: 'electron-ipc', enclosingSymbolId: enclosingId,
            lineNumber: captureMap['channel.consumer'].startPosition.row,
          });
        }
        continue;
      }

      // Electron IPC producer: ipcRenderer.invoke('channel'), ipcRenderer.send('channel'), ipcRenderer.sendSync('channel')
      if (captureMap['channel.producer'] && captureMap['channel.name'] && captureMap['channel.method']) {
        const methodName = captureMap['channel.method'].text;
        if (methodName === 'invoke' || methodName === 'send' || methodName === 'sendSync') {
          const channelName = captureMap['channel.name'].text;
          const enclosingId = findEnclosingFunctionId(captureMap['channel.producer'], file.path, provider) ?? generateId('File', file.path);
          result.channels.push({
            filePath: file.path, channelName, role: 'producer',
            transport: 'electron-ipc', enclosingSymbolId: enclosingId,
            lineNumber: captureMap['channel.producer'].startPosition.row,
          });
        }
        continue;
      }

      // Electron IPC push: webContents.send('channel') — main → renderer
      if (captureMap['channel.producer.webcontents'] && captureMap['channel.name']) {
        const channelName = captureMap['channel.name'].text;
        const enclosingId = findEnclosingFunctionId(captureMap['channel.producer.webcontents'], file.path, provider) ?? generateId('File', file.path);
        result.channels.push({
          filePath: file.path, channelName, role: 'producer',
          transport: 'electron-ipc', enclosingSymbolId: enclosingId,
          lineNumber: captureMap['channel.producer.webcontents'].startPosition.row,
        });
        continue;
      }

      // Socket.IO / EventEmitter consumer: socket.on('event', fn), emitter.on('event', fn)
      if (captureMap['channel.consumer.socket'] && captureMap['channel.name']) {
        const channelName = captureMap['channel.name'].text;
        // Skip built-in socket lifecycle events that aren't message channels
        if (channelName !== 'connect' && channelName !== 'disconnect' && channelName !== 'error' && channelName !== 'connection') {
          const enclosingId = findEnclosingFunctionId(captureMap['channel.consumer.socket'], file.path, provider) ?? generateId('File', file.path);
          const objName = captureMap['channel.object']?.text ?? '';
          const transport = (objName === 'socket' || objName === 'io') ? 'socket.io' as const : 'event-emitter' as const;
          result.channels.push({
            filePath: file.path, channelName, role: 'consumer',
            transport, enclosingSymbolId: enclosingId,
            lineNumber: captureMap['channel.consumer.socket'].startPosition.row,
          });
        }
        continue;
      }

      // Socket.IO / EventEmitter producer: socket.emit('event', data), emitter.emit('event', data)
      if (captureMap['channel.producer.socket'] && captureMap['channel.name']) {
        const channelName = captureMap['channel.name'].text;
        const enclosingId = findEnclosingFunctionId(captureMap['channel.producer.socket'], file.path, provider) ?? generateId('File', file.path);
        const objName = captureMap['channel.object']?.text ?? '';
        const transport = (objName === 'socket' || objName === 'io') ? 'socket.io' as const : 'event-emitter' as const;
        result.channels.push({
          filePath: file.path, channelName, role: 'producer',
          transport, enclosingSymbolId: enclosingId,
          lineNumber: captureMap['channel.producer.socket'].startPosition.row,
        });
        continue;
      }

      // C# channel patterns: obj.On("event", handler), obj.Emit("event", data)
      if (captureMap['channel.csharp'] && captureMap['channel.name'] && captureMap['channel.method']) {
        const methodName = captureMap['channel.method'].text;
        const rawName = captureMap['channel.name'].text;
        // Strip C# string literal quotes: "event" → event
        const channelName = rawName.replace(/^["']|["']$/g, '');
        if (channelName && (methodName === 'On' || methodName === 'OnRequest' || methodName === 'OnResponse'
            || methodName === 'Emit' || methodName === 'EmitRequest' || methodName === 'EmitFailure')) {
          const role = methodName.startsWith('On') ? 'consumer' as const : 'producer' as const;
          const enclosingId = findEnclosingFunctionId(captureMap['channel.csharp'], file.path, provider) ?? generateId('File', file.path);
          result.channels.push({
            filePath: file.path, channelName, role,
            transport: 'csharp-emitter', enclosingSymbolId: enclosingId,
            lineNumber: captureMap['channel.csharp'].startPosition.row,
          });
        }
        continue;
      }

      // Socket.IO/EventEmitter with const variable: socket.emit(SOME_CONST, data)
      if ((captureMap['channel.consumer.socket.var'] || captureMap['channel.producer.socket.var']) && captureMap['channel.name.var']) {
        const varName = captureMap['channel.name.var'].text;
        const channelName = constValueMap.get(varName);
        if (channelName) {
          const isConsumer = !!captureMap['channel.consumer.socket.var'];
          const enclosingId = findEnclosingFunctionId(
            captureMap['channel.consumer.socket.var'] ?? captureMap['channel.producer.socket.var'],
            file.path, provider
          ) ?? generateId('File', file.path);
          const objName = captureMap['channel.object']?.text ?? '';
          const transport = (objName === 'socket' || objName === 'io') ? 'socket.io' as const : 'event-emitter' as const;
          // Skip lifecycle events
          if (channelName !== 'connect' && channelName !== 'disconnect' && channelName !== 'error' && channelName !== 'connection') {
            result.channels.push({
              filePath: file.path, channelName,
              role: isConsumer ? 'consumer' : 'producer',
              transport, enclosingSymbolId: enclosingId,
              lineNumber: (captureMap['channel.consumer.socket.var'] ?? captureMap['channel.producer.socket.var']).startPosition.row,
            });
          }
        }
        continue;
      }

      // Socket.IO/EventEmitter with member expression: socket.on(OBJ.PROP, fn)
      if ((captureMap['channel.consumer.socket.member'] || captureMap['channel.producer.socket.member']) && captureMap['channel.ref.obj'] && captureMap['channel.ref.prop']) {
        const refObj = captureMap['channel.ref.obj'].text;
        const refProp = captureMap['channel.ref.prop'].text;
        // Try same-file object value map first
        let channelName = objectValueMap.get(refObj)?.get(refProp);
        // If not found, store placeholder for cross-file resolution: @ObjName.PropName
        if (!channelName) channelName = `@${refObj}.${refProp}`;
        const isConsumer = !!captureMap['channel.consumer.socket.member'];
        const enclosingId = findEnclosingFunctionId(
          captureMap['channel.consumer.socket.member'] ?? captureMap['channel.producer.socket.member'],
          file.path, provider
        ) ?? generateId('File', file.path);
        const objName = captureMap['channel.object']?.text ?? '';
        // For chained calls like getIO().on(OBJ.PROP), channel.object is absent — default to socket.io
        const transport = (!objName || objName === 'socket' || objName === 'io') ? 'socket.io' as const : 'event-emitter' as const;
        if (channelName !== 'connect' && channelName !== 'disconnect' && channelName !== 'error' && channelName !== 'connection') {
          result.channels.push({
            filePath: file.path, channelName,
            role: isConsumer ? 'consumer' : 'producer',
            transport, enclosingSymbolId: enclosingId,
            lineNumber: (captureMap['channel.consumer.socket.member'] ?? captureMap['channel.producer.socket.member']).startPosition.row,
          });
        }
        continue;
      }

      // C# Socket.IO wrapper with const variable: _socket.Emit(SOME_CONST, data)
      if (captureMap['channel.csharp.var'] && captureMap['channel.name.var'] && captureMap['channel.method']) {
        const methodName = captureMap['channel.method'].text;
        const varName = captureMap['channel.name.var'].text;
        if (methodName === 'On' || methodName === 'OnRequest' || methodName === 'OnResponse'
            || methodName === 'Emit' || methodName === 'EmitRequest' || methodName === 'EmitFailure') {
          const role = methodName.startsWith('On') ? 'consumer' as const : 'producer' as const;
          const enclosingId = findEnclosingFunctionId(captureMap['channel.csharp.var'], file.path, provider) ?? generateId('File', file.path);
          // Resolve const field to string value if available
          const channelName = constValueMap.get(varName) ?? varName;
          result.channels.push({
            filePath: file.path, channelName, role,
            transport: 'csharp-emitter', enclosingSymbolId: enclosingId,
            lineNumber: captureMap['channel.csharp.var'].startPosition.row,
          });
        }
        continue;
      }

      // C# event fire: OnConnected?.Invoke(this, args)
      if (captureMap['event.fire'] && captureMap['event.fire.name']) {
        const eventName = captureMap['event.fire.name'].text;
        const enclosingId = findEnclosingFunctionId(captureMap['event.fire'], file.path, provider) ?? generateId('File', file.path);
        result.eventRefs.push({
          filePath: file.path, eventName, role: 'fire',
          enclosingSymbolId: enclosingId,
          lineNumber: captureMap['event.fire'].startPosition.row,
        });
        continue;
      }

      // C# event subscription: obj.OnConnected += handler
      if (captureMap['event.subscribe'] && captureMap['event.name']) {
        const eventName = captureMap['event.name'].text;
        const receiverText = captureMap['event.receiver']?.text;
        const handlerNode = captureMap['event.handler'];
        const handlerName = handlerNode?.type === 'identifier' ? handlerNode.text : undefined;
        const enclosingId = findEnclosingFunctionId(captureMap['event.subscribe'], file.path, provider) ?? generateId('File', file.path);
        result.eventRefs.push({
          filePath: file.path, eventName, role: 'subscribe',
          enclosingSymbolId: enclosingId,
          receiverText, handlerName,
          lineNumber: captureMap['event.subscribe'].startPosition.row,
        });
        continue;
      }

      // Extract HTTP consumer URLs: fetch(), axios.get(), $.get(), requests.get(), etc.
      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row,
          });
        }
        continue;
      }

      // HTTP client calls: axios.get('/path'), $.post('/path'), requests.get('/path')
      // Skip methods also in EXPRESS_ROUTE_METHODS to avoid double-registering Express
      // routes as both route definitions AND consumers (both queries match same AST node)
      if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        if (method && HTTP_CLIENT_ONLY_METHODS.has(method) && url.startsWith('/')) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
        continue;
      }

      // Express/Hono route registration: app.get('/path', handler)
      if (captureMap['express_route'] && captureMap['express_route.method'] && captureMap['express_route.path']) {
        const method = captureMap['express_route.method'].text;
        const routePath = captureMap['express_route.path'].text;
        if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith('/')) {
          const httpMethod = method === 'all' || method === 'use' || method === 'route' ? 'GET' : method.toUpperCase();
          result.decoratorRoutes.push({
            filePath: file.path,
            routePath,
            httpMethod,
            decoratorName: `express.${method}`,
            lineNumber: captureMap['express_route'].startPosition.row,
          });
        }
        continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const calledName = callNameNode.text;

          // Dispatch: route language-specific calls (heritage, properties, imports)
          const routed = callRouter?.(calledName, captureMap['call']);
          if (routed) {
            if (routed.kind === 'skip') continue;

            if (routed.kind === 'import') {
              result.imports.push({
                filePath: file.path,
                rawImportPath: routed.importPath,
                language,
              });
              continue;
            }

            if (routed.kind === 'heritage') {
              for (const item of routed.items) {
                result.heritage.push({
                  filePath: file.path,
                  className: item.enclosingClass,
                  parentName: item.mixinName,
                  kind: item.heritageKind,
                });
              }
              continue;
            }

            if (routed.kind === 'properties') {
              const propEnclosingClassId = cachedFindEnclosingClassId(captureMap['call'], file.path);
              // Enrich routed properties with FieldExtractor metadata
              let routedFieldMap: Map<string, FieldInfo> | undefined;
              if (provider.fieldExtractor && typeEnv) {
                const classNode = findEnclosingClassNode(captureMap['call']);
                if (classNode) {
                  routedFieldMap = getFieldInfo(classNode, provider, {
                    typeEnv, symbolTable: NOOP_SYMBOL_TABLE, filePath: file.path, language,
                  });
                }
              }
              for (const item of routed.items) {
                const routedFieldInfo = routedFieldMap?.get(item.propName);
                const nodeId = generateId('Property', `${file.path}:${item.propName}`);
                result.nodes.push({
                  id: nodeId,
                  label: 'Property',
                  properties: {
                    name: item.propName,
                    filePath: file.path,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    language,
                    isExported: true,
                    description: item.accessorType,
                    ...(item.declaredType ? { declaredType: item.declaredType } : routedFieldInfo?.type ? { declaredType: routedFieldInfo.type } : {}),
                    ...(routedFieldInfo?.visibility !== undefined ? { visibility: routedFieldInfo.visibility } : {}),
                    ...(routedFieldInfo?.isStatic !== undefined ? { isStatic: routedFieldInfo.isStatic } : {}),
                    ...(routedFieldInfo?.isReadonly !== undefined ? { isReadonly: routedFieldInfo.isReadonly } : {}),
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                  ...(item.declaredType ? { declaredType: item.declaredType } : routedFieldInfo?.type ? { declaredType: routedFieldInfo.type } : {}),
                  ...(routedFieldInfo?.visibility !== undefined ? { visibility: routedFieldInfo.visibility } : {}),
                  ...(routedFieldInfo?.isStatic !== undefined ? { isStatic: routedFieldInfo.isStatic } : {}),
                  ...(routedFieldInfo?.isReadonly !== undefined ? { isReadonly: routedFieldInfo.isReadonly } : {}),
                });
                const fileId = generateId('File', file.path);
                const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                result.relationships.push({
                  id: relId,
                  sourceId: fileId,
                  targetId: nodeId,
                  type: 'DEFINES',
                  confidence: 1.0,
                  reason: '',
                });
                if (propEnclosingClassId) {
                  result.relationships.push({
                    id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_PROPERTY',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }

            // kind === 'call' — fall through to normal call processing below
          }

          if (!provider.isBuiltInName(calledName)) {
            const callNode = captureMap['call'];
            const sourceId = findEnclosingFunctionId(callNode, file.path, provider)
              || generateId('File', file.path);
            const callForm = inferCallForm(callNode, callNameNode);
            let receiverName = callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
            let receiverTypeName = receiverName ? typeEnv.lookup(receiverName, callNode) : undefined;
            let receiverMixedChain: MixedChainStep[] | undefined;

            // When the receiver is a complex expression (call chain, field chain, or mixed),
            // extractReceiverName returns undefined. Walk the receiver node to build a unified
            // mixed chain for deferred resolution in processCallsFromExtracted.
            if (callForm === 'member' && receiverName === undefined && !receiverTypeName) {
              const receiverNode = extractReceiverNode(callNameNode);
              if (receiverNode) {
                const extracted = extractMixedChain(receiverNode);
                if (extracted && extracted.chain.length > 0) {
                  receiverMixedChain = extracted.chain;
                  receiverName = extracted.baseReceiverName;
                  // Try the type environment immediately for the base receiver
                  // (covers explicitly-typed locals and annotated parameters).
                  if (receiverName) {
                    receiverTypeName = typeEnv.lookup(receiverName, callNode);
                  }
                }
              }
            }

            // Check if call is inside an await expression
            const isAwaited = callNode.parent?.type === 'await_expression';
            result.calls.push({
              filePath: file.path,
              calledName,
              sourceId,
              argCount: countCallArguments(callNode),
              ...(callForm !== undefined ? { callForm } : {}),
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
              ...(receiverMixedChain !== undefined ? { receiverMixedChain } : {}),
              ...(isAwaited ? { isAwaited: true } : {}),
            });
          }
        }
        continue;
      }

      // Extract heritage (extends/implements)
      if (captureMap['heritage.class']) {
        if (captureMap['heritage.extends']) {
          // Go struct embedding: the query matches ALL field_declarations with
          // type_identifier, but only anonymous fields (no name) are embedded.
          // Named fields like `Breed string` also match — skip them.
          const extendsNode = captureMap['heritage.extends'];
          const fieldDecl = extendsNode.parent;
          const isNamedField = fieldDecl?.type === 'field_declaration'
            && fieldDecl.childForFieldName('name');
          if (!isNamedField) {
            result.heritage.push({
              filePath: file.path,
              className: captureMap['heritage.class'].text,
              parentName: captureMap['heritage.extends'].text,
              kind: 'extends',
            });
          }
        }
        if (captureMap['heritage.implements']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
        if (captureMap['heritage.trait']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait-impl',
          });
        }
        if (captureMap['heritage.extends'] || captureMap['heritage.implements'] || captureMap['heritage.trait']) {
          continue;
        }
      }

      const nodeLabel = getLabelFromCaptures(captureMap, provider);
      if (!nodeLabel) continue;

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') continue;
      const nodeName = nameNode ? nameNode.text : 'init';
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNode ? definitionNode.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      const description = provider.descriptionExtractor?.(nodeLabel, nodeName, captureMap);

      let frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      // Decorators appear on lines immediately before their definition; allow up to
      // MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
      const MAX_DECORATOR_SCAN_LINES = 5;
      if (definitionNode) {
        const defStartLine = definitionNode.startPosition.row;
        for (let checkLine = defStartLine - 1; checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES); checkLine--) {
          const dec = fileDecorators.get(checkLine);
          if (dec) {
            // Use first (closest) decorator found for framework hint
            if (!frameworkHint) {
              frameworkHint = {
                framework: 'decorator',
                entryPointMultiplier: 1.2,
                reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ''}`,
              };
            }
            // Emit tool definition if this is a @tool decorator
            if (dec.isTool) {
              result.toolDefs.push({
                filePath: file.path,
                toolName: nodeName,
                description: dec.arg || '',
                lineNumber: definitionNode.startPosition.row,
              });
            }
            fileDecorators.delete(checkLine);
          }
        }
      }

      let parameterCount: number | undefined;
      let requiredParameterCount: number | undefined;
      let parameterTypes: string[] | undefined;
      let returnType: string | undefined;
      let declaredType: string | undefined;
      let visibility: string | undefined;
      let isStatic: boolean | undefined;
      let isReadonly: boolean | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const sig = extractMethodSignature(definitionNode);
        parameterCount = sig.parameterCount;
        requiredParameterCount = sig.requiredParameterCount;
        parameterTypes = sig.parameterTypes;
        returnType = sig.returnType;

        // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
        // Also upgrades uninformative AST types like PHP `array` with PHPDoc `@return User[]`
        if ((!returnType || returnType === 'array' || returnType === 'iterable') && definitionNode) {
          const tc = provider.typeConfig;
          if (tc?.extractReturnType) {
            const docReturn = tc.extractReturnType(definitionNode);
            if (docReturn) returnType = docReturn;
          }
        }
      } else if (nodeLabel === 'Property' && definitionNode) {
        // FieldExtractor is the single source of truth when available
        if (provider.fieldExtractor && typeEnv) {
          const classNode = findEnclosingClassNode(definitionNode);
          if (classNode) {
            const fieldMap = getFieldInfo(classNode, provider, {
              typeEnv, symbolTable: NOOP_SYMBOL_TABLE, filePath: file.path, language,
            });
            const info = fieldMap?.get(nodeName);
            if (info) {
              declaredType = info.type ?? undefined;
              visibility = info.visibility;
              isStatic = info.isStatic;
              isReadonly = info.isReadonly;
            }
          }
        }
      }

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNode ? definitionNode.startPosition.row : startLine,
          endLine: definitionNode ? definitionNode.endPosition.row : startLine,
          language: language,
          isExported: cachedExportCheck(provider.exportChecker, nameNode || definitionNode, nodeName),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
           ...(description !== undefined ? { description } : {}),
           ...((nodeLabel === 'Class' || nodeLabel === 'Struct' || nodeLabel === 'Interface' || nodeLabel === 'Enum' || nodeLabel === 'Record')
              && language === SupportedLanguages.CSharp
              ? (() => { const ns = findEnclosingNamespace(definitionNode || nameNode); return ns ? { namespace: ns } : {}; })()
              : {}),
           ...(parameterCount !== undefined ? { parameterCount } : {}),
          ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
           ...(parameterTypes !== undefined ? { parameterTypes } : {}),
           ...(returnType !== undefined ? { returnType } : {}),
           ...(declaredType !== undefined ? { declaredType } : {}),
           ...(visibility !== undefined ? { visibility } : {}),
           ...(isStatic !== undefined ? { isStatic } : {}),
           ...(isReadonly !== undefined ? { isReadonly } : {}),
            ...((nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') && definitionNode
               ? (() => {
                   // Detect async: TS/JS async_function_declaration, async_arrow_function, etc.
                   let isAsync = definitionNode.type?.includes('async') ?? false;
                   // C# async modifier on method_declaration
                   if (!isAsync && language === SupportedLanguages.CSharp) {
                     for (let mi = 0; mi < definitionNode.childCount; mi++) {
                       const ch = definitionNode.child(mi);
                       if (ch?.type === 'modifier' && ch.text === 'async') { isAsync = true; break; }
                       if (ch?.type !== 'modifier' && ch?.isNamed) break;
                     }
                   }
                   return isAsync ? { isAsync: true } : {};
                 })()
               : {})
        },
      });

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? cachedFindEnclosingClassId(nameNode || definitionNode, file.path) : null;

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
        ...(parameterTypes !== undefined ? { parameterTypes } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
        ...(declaredType !== undefined ? { declaredType } : {}),
        ...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
        ...(isStatic !== undefined ? { isStatic } : {}),
        ...(isReadonly !== undefined ? { isReadonly } : {}),
      });

      const fileId = generateId('File', file.path);
      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
      result.relationships.push({
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      });

      // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
      if (enclosingClassId) {
        const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
        result.relationships.push({
          id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: memberEdgeType,
          confidence: 1.0,
          reason: '',
        });
      }

      // Detect C# override methods — collect for post-parse override resolution
      if (language === SupportedLanguages.CSharp && enclosingClassId
          && (nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property')
          && definitionNode) {
        let isStatic = false;
        let isOverride = false;
        // Check modifiers
        for (let i = 0; i < definitionNode.childCount; i++) {
          const child = definitionNode.child(i);
          if (child?.type === 'modifier') {
            if (child.text === 'override') isOverride = true;
            if (child.text === 'static') isStatic = true;
          } else if (child?.isNamed) break; // Past modifiers
        }

        if (isOverride) {
          result.overrides.push({
            filePath: file.path,
            methodName: nodeName,
            methodNodeId: nodeId,
            enclosingClassId,
          });
        }

        // Detect C# extension methods — static method with `this` modifier on first parameter
        if (isStatic && nodeLabel === 'Method') {
          const paramList = definitionNode.childForFieldName?.('parameters')
            ?? definitionNode.children?.find((c: any) => c.type === 'parameter_list');
          if (paramList) {
            const firstParam = paramList.namedChildren?.[0];
            if (firstParam?.type === 'parameter') {
              const firstChild = firstParam.child(0);
              if (firstChild?.type === 'modifier' && firstChild.text === 'this') {
                // Extract the extended type name
                const typeNode = firstParam.childForFieldName?.('type');
                if (typeNode) {
                  // Handle: identifier, predefined_type, generic_name, array_type, nullable_type
                  let typeName: string | null = null;
                  if (typeNode.type === 'identifier') {
                    typeName = typeNode.text;
                  } else if (typeNode.type === 'generic_name') {
                    // Extract base identifier from generic: IEnumerable<T> → IEnumerable
                    const baseId = typeNode.children?.find((c: any) => c.type === 'identifier');
                    typeName = baseId?.text ?? null;
                  }
                  // Skip predefined_type (string, int, etc.) — no graph node to link to
                  if (typeName && typeNode.type !== 'predefined_type') {
                    result.extensionMethods.push({
                      filePath: file.path,
                      methodName: nodeName,
                      methodNodeId: nodeId,
                      extendedTypeName: typeName,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Extract framework routes via provider detection (e.g., Laravel routes.php)
    if (provider.isRouteFile?.(file.path)) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      result.routes.push(...extractedRoutes);
    }

    // Extract ORM queries (Prisma, Supabase)
    extractORMQueries(file.path, file.content, result.ormQueries);

    // ── N2: Emit wrapper detection — data-flow through function parameters ──
    // ── N2: Emit wrapper detection — data-flow through function parameters ──
    // Detect functions in this file that call *.emit(param) where param is a function
    // parameter. At call sites where the wrapper is called with a const, create a channel.
    if ((language === SupportedLanguages.JavaScript || language === SupportedLanguages.TypeScript)
        && constValueMap.size > 0) {
      interface EmitWrapperInfo { paramIndex: number; suffix?: string; role?: 'producer' | 'consumer'; }

      const emitWrappers = new Map<string, EmitWrapperInfo[]>(); // funcName → [{ paramIndex, suffix?, role? }]

      /** Resolve a suffix value from a node (string literal, member expression, or identifier) */
      const resolveSuffixNode = (node: any): string | undefined => {
        if (!node) return undefined;
        if (node.type === 'string') return node.namedChildren?.find((c: any) => c.type === 'string_fragment')?.text;
        if (node.type === 'member_expression') {
          const sObj = node.childForFieldName?.('object')?.text;
          const sProp = node.childForFieldName?.('property')?.text;
          if (sObj && sProp) {
            const resolved = objectValueMap.get(sObj)?.get(sProp);
            if (resolved) return resolved;
            // Fallback: common suffix naming convention
            if (sProp === 'REQUEST' || sProp === 'RESPONSE' || sProp === 'FAILED')
              return sProp.charAt(0) + sProp.slice(1).toLowerCase();
          }
        }
        if (node.type === 'identifier') return constValueMap.get(node.text);
        return undefined;
      };

      const findEmitInBody = (bodyNode: any, paramNames: string[]): EmitWrapperInfo[] => {
        // First pass: collect local var → param mappings (single-hop)
        const localVarToParam = new Map<string, { paramIdx: number; suffix?: string }>();
        const stack1 = [bodyNode];
        while (stack1.length > 0) {
          const nd = stack1.pop();
          if (!nd) continue;
          if (nd.type === 'variable_declarator') {
            const varName = nd.childForFieldName?.('name')?.text;
            const val = nd.childForFieldName?.('value');
            if (varName && val) {
              if (val.type === 'binary_expression') {
                const left = val.childForFieldName?.('left');
                const right = val.childForFieldName?.('right');
                if (left?.type === 'identifier') {
                  const pIdx = paramNames.indexOf(left.text);
                  if (pIdx >= 0) {
                    const suffix = resolveSuffixNode(right);
                    if (suffix) localVarToParam.set(varName, { paramIdx: pIdx, suffix });
                  }
                }
              }
              if (val.type === 'call_expression') {
                const callArgs = val.childForFieldName?.('arguments')?.namedChildren ?? [];
                if (callArgs[0]?.type === 'identifier') {
                  const pIdx = paramNames.indexOf(callArgs[0].text);
                  if (pIdx >= 0) {
                    const suffix = resolveSuffixNode(callArgs[1]);
                    if (suffix) localVarToParam.set(varName, { paramIdx: pIdx, suffix });
                  }
                }
              }
            }
          }
          for (let ci = 0; ci < (nd.childCount ?? 0); ci++) stack1.push(nd.child(ci));
        }

        // Multi-hop: resolve locals derived from other already-resolved locals
        // e.g., event = getEvent(eventName, ...) [hop 1], requestEvent = event + 'Request' [hop 2]
        let changed = true;
        let passes = 0;
        while (changed && passes < 3) {
          changed = false;
          passes++;
          const stack1b = [bodyNode];
          while (stack1b.length > 0) {
            const nd = stack1b.pop();
            if (!nd) continue;
            if (nd.type === 'variable_declarator') {
              const varName = nd.childForFieldName?.('name')?.text;
              const val = nd.childForFieldName?.('value');
              if (varName && val && !localVarToParam.has(varName)) {
                if (val.type === 'binary_expression') {
                  const left = val.childForFieldName?.('left');
                  const right = val.childForFieldName?.('right');
                  if (left?.type === 'identifier') {
                    const resolved = localVarToParam.get(left.text);
                    if (resolved) {
                      const suffix = resolveSuffixNode(right);
                      if (suffix) {
                        // Hop 2+: replace suffix (getEvent strips, then hop re-appends)
                        localVarToParam.set(varName, { paramIdx: resolved.paramIdx, suffix });
                        changed = true;
                      }
                    }
                  }
                }
                if (val.type === 'call_expression') {
                  const callArgs = val.childForFieldName?.('arguments')?.namedChildren ?? [];
                  if (callArgs[0]?.type === 'identifier') {
                    const resolved = localVarToParam.get(callArgs[0].text);
                    if (resolved) {
                      const suffix = resolveSuffixNode(callArgs[1]);
                      if (suffix) {
                        localVarToParam.set(varName, { paramIdx: resolved.paramIdx, suffix });
                        changed = true;
                      }
                    }
                  }
                }
              }
            }
            for (let ci = 0; ci < (nd.childCount ?? 0); ci++) stack1b.push(nd.child(ci));
          }
        }

        // Second pass: find socket.emit/once/on(firstArg, ...) — ALL channel references
        const results: EmitWrapperInfo[] = [];
        const stack2 = [bodyNode];
        while (stack2.length > 0) {
          const nd = stack2.pop();
          if (!nd) continue;
          if (nd.type === 'call_expression') {
            const fn = nd.childForFieldName?.('function');
            if (fn?.type === 'member_expression') {
              const methodName = fn.childForFieldName?.('property')?.text;
              if (methodName === 'emit' || methodName === 'once' || methodName === 'on') {
                const args = nd.childForFieldName?.('arguments');
                const firstArg = args?.namedChildren?.[0];
                if (firstArg?.type === 'identifier') {
                  const role = methodName === 'emit' ? 'producer' as const : 'consumer' as const;
                  const directIdx = paramNames.indexOf(firstArg.text);
                  if (directIdx >= 0) {
                    results.push({ paramIndex: directIdx, role });
                  } else {
                    const indirect = localVarToParam.get(firstArg.text);
                    if (indirect) {
                      results.push({ paramIndex: indirect.paramIdx, suffix: indirect.suffix, role });
                    }
                  }
                }
              }
            }
          }
          for (let ci = 0; ci < (nd.childCount ?? 0); ci++) stack2.push(nd.child(ci));
        }
        return results;
      };

      // Phase 1: Find emit wrappers among function/method definitions
      for (const m of matches) {
        const cm: Record<string, any> = {};
        for (const c of m.captures) cm[c.name] = c.node;
        const defNode = cm['definition.function'] ?? cm['definition.method'] ?? cm['definition.property'];
        if (!defNode) continue;
        const fName = cm['name']?.text;
        if (!fName) continue;
        let pList = defNode.childForFieldName?.('parameters')
          ?? defNode.children?.find((c: any) => c.type === 'formal_parameters' || c.type === 'parameter_list');
        if (!pList) {
          // For arrow function class fields: myEmitter = async (id, event, data) => { ... }
          // defNode is field_definition → value is arrow_function → has parameters + body
          const arrowFn = defNode.namedChildren?.find((c: any) => c.type === 'arrow_function' || c.type === 'function_expression');
          if (arrowFn) {
            pList = arrowFn.childForFieldName?.('parameters')
              ?? arrowFn.children?.find((c: any) => c.type === 'formal_parameters');
          }
        }
        if (!pList) continue;
        const pNames: string[] = [];
        for (const p of pList.namedChildren ?? []) {
          const n = p.type === 'identifier' ? p : p.childForFieldName?.('pattern') ?? p.childForFieldName?.('name');
          if (n?.type === 'identifier') pNames.push(n.text);
        }
        if (pNames.length === 0) continue;
        let body = defNode.childForFieldName?.('body');
        if (!body) {
          // Arrow function class fields: body is on the arrow function child
          const arrowFn = defNode.namedChildren?.find((c: any) => c.type === 'arrow_function' || c.type === 'function_expression');
          body = arrowFn?.childForFieldName?.('body');
        }
        if (!body) continue;
        const emitInfos = findEmitInBody(body, pNames);
        if (emitInfos.length > 0) emitWrappers.set(fName, emitInfos);
      }

      // Phase 2: At call sites with const args → create channel edges for each wrapper result
      if (emitWrappers.size > 0) {
        for (const m of matches) {
          const cm: Record<string, any> = {};
          for (const c of m.captures) cm[c.name] = c.node;
          if (!cm['call'] || !cm['call.name']) continue;
          const calledName = cm['call.name'].text;
          const wrapperInfos = emitWrappers.get(calledName);
          if (!wrapperInfos) continue;

          const callNode = cm['call'];
          const argsNode = callNode.childForFieldName?.('arguments');
          if (!argsNode) continue;

          // For each channel the wrapper emits/listens, resolve the const arg and apply suffix
          for (const wi of wrapperInfos) {
            const eventArg = (argsNode.namedChildren ?? [])[wi.paramIndex];
            if (!eventArg) continue;
            let baseChName: string | undefined;
            if (eventArg.type === 'identifier') baseChName = constValueMap.get(eventArg.text);
            else if (eventArg.type === 'string') {
              const frag = eventArg.namedChildren?.find((c: any) => c.type === 'string_fragment');
              baseChName = frag?.text;
            }
            if (baseChName && baseChName !== 'connect' && baseChName !== 'disconnect' && baseChName !== 'error') {
              const encId = findEnclosingFunctionId(callNode, file.path, provider) ?? generateId('File', file.path);
              const chName = wi.suffix ? baseChName + wi.suffix : baseChName;
              result.channels.push({
                filePath: file.path, channelName: chName,
                role: wi.role ?? 'producer',
                transport: 'socket.io', enclosingSymbolId: encId,
                lineNumber: callNode.startPosition.row,
              });
            }
          }
      }
    }
  }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], assignments: [], heritage: [], routes: [], fetchCalls: [], decoratorRoutes: [], toolDefs: [], ormQueries: [], channels: [], eventRefs: [], overrides: [], extensionMethods: [], contextRefs: [], constValues: [], constructorBindings: [], typeEnvBindings: [], skippedLanguages: {}, fileCount: 0,
};
let cumulativeProcessed = 0;

const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
  target.nodes.push(...src.nodes);
  target.relationships.push(...src.relationships);
  target.symbols.push(...src.symbols);
  target.imports.push(...src.imports);
  target.calls.push(...src.calls);
  target.assignments.push(...src.assignments);
  target.heritage.push(...src.heritage);
  target.routes.push(...src.routes);
  target.fetchCalls.push(...src.fetchCalls);
  target.decoratorRoutes.push(...src.decoratorRoutes);
  target.toolDefs.push(...src.toolDefs);
  target.ormQueries.push(...src.ormQueries);
  target.channels.push(...src.channels);
  target.eventRefs.push(...src.eventRefs);
  target.overrides.push(...src.overrides);
  target.extensionMethods.push(...src.extensionMethods);
  target.contextRefs.push(...src.contextRefs);
  target.constValues.push(...src.constValues);
  target.constructorBindings.push(...src.constructorBindings);
  target.typeEnvBindings.push(...src.typeEnvBindings);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

parentPort!.on('message', (msg: any) => {
  try {
    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg && msg.type === 'sub-batch') {
      const result = processBatch(msg.files, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed: cumulativeProcessed + filesProcessed });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      // Signal ready for next sub-batch
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg && msg.type === 'flush') {
      parentPort!.postMessage({ type: 'result', data: accumulated });
      // Reset for potential reuse
      accumulated = { nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [], routes: [], fetchCalls: [], decoratorRoutes: [], toolDefs: [], ormQueries: [], channels: [], eventRefs: [], overrides: [], extensionMethods: [], contextRefs: [], constValues: [], constructorBindings: [], typeEnvBindings: [], skippedLanguages: {}, fileCount: 0 };
      cumulativeProcessed = 0;
      return;
    }

    // Legacy single-message mode (backward compat): array of files
    if (Array.isArray(msg)) {
      const result = processBatch(msg, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed });
      });
      parentPort!.postMessage({ type: 'result', data: result });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', error: message });
  }
});
