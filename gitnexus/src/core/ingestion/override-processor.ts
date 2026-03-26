/**
 * Override Processor
 *
 * Resolves C# `override` methods to their base class virtual/abstract methods
 * and creates OVERRIDES edges. This makes virtual dispatch visible in the graph.
 *
 * Algorithm:
 *   1. For each ExtractedOverride, find the owning class via enclosingClassId
 *   2. Walk the EXTENDS chain upward from that class
 *   3. For each ancestor, check HAS_METHOD edges for a method with the same name
 *   4. When found, create an OVERRIDES edge: overrideMethod → baseMethod
 *
 * Runs AFTER heritage-processor (needs EXTENDS edges) and AFTER partial class
 * unification (needs correct class hierarchy).
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { ExtractedOverride } from './workers/parse-worker.js';
import { generateId } from '../../lib/utils.js';

export interface OverrideProcessorStats {
  totalOverrides: number;
  resolved: number;
  unresolved: number;
  edgesCreated: number;
  syntheticNodesCreated: number;
}

/**
 * Well-known .NET framework types and their virtual/abstract methods.
 * Used to create synthetic graph nodes for override resolution when the
 * base type doesn't exist in the codebase (it's a framework type).
 */
const DOTNET_SYNTHETIC_TYPES: Record<string, string[]> = {
  Object: ['ToString', 'Equals', 'GetHashCode', 'Finalize'],
  IDisposable: ['Dispose'],
  IAsyncDisposable: ['DisposeAsync'],
  Stream: ['Read', 'Write', 'Seek', 'Flush', 'Close', 'SetLength', 'ReadAsync', 'WriteAsync', 'FlushAsync', 'ReadByte', 'WriteByte', 'CopyToAsync', 'CanRead', 'CanWrite', 'CanSeek', 'Length', 'Position'],
  TextWriter: ['Write', 'WriteLine', 'Flush', 'Close', 'Encoding', 'FlushAsync', 'WriteAsync', 'WriteLineAsync'],
  TextReader: ['Read', 'ReadLine', 'ReadToEnd', 'Close', 'ReadAsync', 'ReadLineAsync', 'ReadToEndAsync'],
  Exception: ['Message', 'ToString', 'GetObjectData'],
  Attribute: ['IsDefaultAttribute', 'Match', 'Equals', 'GetHashCode'],
  MarshalByRefObject: ['InitializeLifetimeService', 'CreateObjRef'],
  EventArgs: [],
  ValueType: ['Equals', 'GetHashCode', 'ToString'],
  Enum: ['ToString', 'Equals', 'GetHashCode', 'CompareTo', 'HasFlag', 'GetName'],
  IEnumerable: ['GetEnumerator'],
  IEnumerator: ['MoveNext', 'Reset', 'Current'],
  IComparable: ['CompareTo'],
  IEquatable: ['Equals'],
  IFormattable: ['ToString'],
  ICloneable: ['Clone'],
  ISerializable: ['GetObjectData'],
  DbContext: ['OnModelCreating', 'OnConfiguring', 'SaveChanges', 'SaveChangesAsync'],
};

/**
 * Resolve override methods to their base class definitions and create OVERRIDES edges.
 */
export function processOverrides(
  graph: KnowledgeGraph,
  overrides: ExtractedOverride[],
): OverrideProcessorStats {
  const stats: OverrideProcessorStats = {
    totalOverrides: overrides.length,
    resolved: 0,
    unresolved: 0,
    edgesCreated: 0,
    syntheticNodesCreated: 0,
  };

  if (overrides.length === 0) return stats;

  // Pre-build lookup indexes for fast traversal:
  // 1. classId → parent classIds (from EXTENDS edges)
  // 2. classId → Map<memberName, memberNodeId> (from HAS_METHOD + HAS_PROPERTY edges)
  //    C# abstract properties use HAS_PROPERTY, so we check both.
  const extendsMap = new Map<string, string[]>();
  const classMemberMap = new Map<string, Map<string, string>>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'EXTENDS' || rel.type === 'IMPLEMENTS') {
      let parents = extendsMap.get(rel.sourceId);
      if (!parents) { parents = []; extendsMap.set(rel.sourceId, parents); }
      parents.push(rel.targetId);
    }
    if (rel.type === 'HAS_METHOD' || rel.type === 'HAS_PROPERTY') {
      const targetNode = graph.getNode(rel.targetId);
      if (targetNode) {
        let members = classMemberMap.get(rel.sourceId);
        if (!members) { members = new Map(); classMemberMap.set(rel.sourceId, members); }
        const memberName = targetNode.properties?.name as string;
        if (memberName && !members.has(memberName)) {
          members.set(memberName, rel.targetId);
        }
      }
    }
  }

  // Track created synthetic nodes to avoid duplicates
  const syntheticNodes = new Set<string>();

  /** Create a synthetic .NET framework class + method node if not already created. */
  const ensureSyntheticMethod = (typeName: string, methodName: string): string | null => {
    const classId = generateId('Class', `__dotnet__:${typeName}`);
    const methodId = generateId('Method', `__dotnet__:${typeName}:${methodName}`);

    if (!syntheticNodes.has(classId)) {
      syntheticNodes.add(classId);
      graph.addNode({
        id: classId,
        label: 'Class',
        properties: { name: typeName, filePath: '__dotnet__', startLine: 0, endLine: 0, language: undefined as any, isExported: true, description: `.NET framework type` },
      });
      stats.syntheticNodesCreated++;
    }

    if (!syntheticNodes.has(methodId)) {
      syntheticNodes.add(methodId);
      graph.addNode({
        id: methodId,
        label: 'Method',
        properties: { name: methodName, filePath: '__dotnet__', startLine: 0, endLine: 0, language: undefined as any, isExported: true },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${classId}->${methodId}`),
        sourceId: classId, targetId: methodId, type: 'HAS_METHOD', confidence: 1.0, reason: 'synthetic',
      });
      stats.syntheticNodesCreated++;
    }

    return methodId;
  };

  // For each override method, walk the EXTENDS chain to find the base method
  const seenEdges = new Set<string>();

  for (const ov of overrides) {
    let baseMethodId = findBaseMethod(
      ov.enclosingClassId,
      ov.methodName,
      extendsMap,
      classMemberMap,
      new Set(),
    );

    // If not found via EXTENDS chain, try synthetic .NET base types
    if (!baseMethodId || baseMethodId === ov.methodNodeId) {
      for (const [typeName, methods] of Object.entries(DOTNET_SYNTHETIC_TYPES)) {
        if (methods.includes(ov.methodName)) {
          baseMethodId = ensureSyntheticMethod(typeName, ov.methodName);
          break;
        }
      }
    }

    if (baseMethodId && baseMethodId !== ov.methodNodeId) {
      const edgeKey = `${ov.methodNodeId}->${baseMethodId}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        graph.addRelationship({
          id: generateId('OVERRIDES', edgeKey),
          sourceId: ov.methodNodeId,
          targetId: baseMethodId,
          type: 'OVERRIDES',
          confidence: baseMethodId.startsWith('Method:__dotnet__') ? 0.9 : 1.0,
          reason: `override:${ov.methodName}`,
        });
        stats.edgesCreated++;
      }
      stats.resolved++;
    } else {
      stats.unresolved++;
    }
  }

  return stats;
}

/**
 * Walk the EXTENDS chain upward from `classId` looking for a member (method or property)
 * named `memberName`. Returns the member node ID if found, or null if not in the graph.
 * Checks both HAS_METHOD and HAS_PROPERTY edges (C# abstract properties use HAS_PROPERTY).
 */
function findBaseMethod(
  classId: string,
  memberName: string,
  extendsMap: Map<string, string[]>,
  classMemberMap: Map<string, Map<string, string>>,
  visited: Set<string>,
): string | null {
  if (visited.has(classId)) return null;
  visited.add(classId);

  const parents = extendsMap.get(classId);
  if (!parents) return null;

  for (const parentId of parents) {
    const parentMembers = classMemberMap.get(parentId);
    if (parentMembers?.has(memberName)) {
      return parentMembers.get(memberName)!;
    }

    const found = findBaseMethod(parentId, memberName, extendsMap, classMemberMap, visited);
    if (found) return found;
  }

  return null;
}
