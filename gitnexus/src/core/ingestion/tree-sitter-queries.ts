
/* 
 * Tree-sitter queries for extracting code definitions.
 * 
 * Note: Different grammars (typescript vs tsx vs javascript) may have
 * slightly different node types. These queries are designed to be 
 * compatible with the standard tree-sitter grammars.
 */

// TypeScript queries - works with tree-sitter-typescript
export const TYPESCRIPT_QUERIES = `
(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(function_declaration
  name: (identifier) @name) @definition.function

; TypeScript overload signatures (function_signature is a separate node type from function_declaration)
(function_signature
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; Class properties — public_field_definition covers most TS class fields
(public_field_definition
  name: (property_identifier) @name) @definition.property

; Private class fields: #address: Address
(public_field_definition
  name: (private_property_identifier) @name) @definition.property

; Constructor parameter properties: constructor(public address: Address)
(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @name) @definition.property

; Heritage queries - class extends
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (extends_clause
      value: (identifier) @heritage.extends))) @heritage

; Heritage queries - class implements interface
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (implements_clause
      (type_identifier) @heritage.implements))) @heritage.impl

; Heritage queries - interface extends interface
(interface_declaration
  name: (type_identifier) @heritage.class
  (extends_type_clause
    type: (type_identifier) @heritage.extends)) @heritage

; Write access: obj.field = value
(assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; HTTP consumers: fetch('/path'), axios.get('/path'), $.get('/path'), etc.
; fetch() — global function
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url])) @route.fetch

; axios.get/post/put/delete/patch('/path'), $.get/post/ajax({url:'/path'})
(call_expression
  function: (member_expression
    property: (property_identifier) @http_client.method)
  arguments: (arguments
    (string (string_fragment) @http_client.url))) @http_client

; Decorators: @Controller, @Get, @Post, etc.
(decorator
  (call_expression
    function: (identifier) @decorator.name
    arguments: (arguments (string (string_fragment) @decorator.arg)?))) @decorator

; Express/Hono route registration: app.get('/path', handler), router.post('/path', fn)
(call_expression
  function: (member_expression
    property: (property_identifier) @express_route.method)
  arguments: (arguments
    (string (string_fragment) @express_route.path))) @express_route

; ── React Context captures (Provider → Consumer data flow) ────────────────

; useContext consumer: useContext(ContextName) — component consumes context data
(call_expression
  function: (identifier) @_uc (#eq? @_uc "useContext")
  arguments: (arguments
    .
    (identifier) @context.consumed)) @context.consumer

; ── Message channel captures (Electron IPC, Socket.IO, EventEmitter) ──────

; Electron IPC consumer: ipcMain.handle('channel', fn), ipcMain.on('channel', fn)
(call_expression
  function: (member_expression
    object: (identifier) @_ipc_obj (#eq? @_ipc_obj "ipcMain")
    property: (property_identifier) @channel.method)
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer

; Electron IPC producer: ipcRenderer.invoke('channel'), ipcRenderer.send('channel'), ipcRenderer.sendSync('channel')
(call_expression
  function: (member_expression
    object: (identifier) @_ipc_obj2 (#eq? @_ipc_obj2 "ipcRenderer")
    property: (property_identifier) @channel.method)
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer

; Electron IPC event listener: ipcRenderer.on('channel', fn) — receives push from main process
(call_expression
  function: (member_expression
    object: (identifier) @_ipc_obj3 (#eq? @_ipc_obj3 "ipcRenderer")
    property: (property_identifier) @_on_method (#eq? @_on_method "on"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer

; Electron IPC push: webContents.send('channel') — main pushes to renderer
(call_expression
  function: (member_expression
    property: (property_identifier) @_send_method (#eq? @_send_method "send"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer.webcontents

; Socket.IO server/client listener: socket.on('event', fn), io.on('event', fn)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_method2 (#match? @_on_method2 "^(on|once)$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer.socket

; Socket.IO/EventEmitter listener via this: this.socket.on('event', fn), this.emitter.on('event', fn)
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_on_method3 (#match? @_on_method3 "^(on|once)$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer.socket

; Socket.IO emit: socket.emit('event', data), io.emit('event', data)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_method (#match? @_emit_method "^emit$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer.socket

; Socket.IO/EventEmitter emit via this: this.socket.emit('event', data), this.emitter.emit('event', data)
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_emit_method2 (#match? @_emit_method2 "^emit$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer.socket

; ── Variable channel name captures (const/identifier first arg) ───────────

; socket.on(VARIABLE, fn) — identifier as first arg (const variable)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_var (#match? @_on_var "^(on|once)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; this.socket.on(VARIABLE, fn) — via this
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_on_var2 (#match? @_on_var2 "^(on|once)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; socket.emit(VARIABLE, data) — identifier as first arg
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_var (#match? @_emit_var "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var

; this.socket.emit(VARIABLE, data) — via this
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_emit_var2 (#match? @_emit_var2 "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var

; socket.on(OBJ.PROP, fn) — member expression as first arg (object property lookup)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_member (#match? @_on_member "^(on|once)$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.consumer.socket.member

; socket.emit(OBJ.PROP, data) — member expression as first arg
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_member (#match? @_emit_member "^emit$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.producer.socket.member

; getIO().on(OBJ.PROP, fn) — chained call as socket object (e.g., getIO().on(...))
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_on_chain (#match? @_on_chain "^(on|once|off)$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.consumer.socket.member

; getIO().emit(OBJ.PROP, data) — chained call emit
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_emit_chain (#match? @_emit_chain "^emit$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.producer.socket.member

; Chained .on(CONST_VAR, handler) — socket.on(...).on(CONST, handler)
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_on_chain_var (#match? @_on_chain_var "^(on|once|off)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; Chained .emit(CONST_VAR, data)
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_emit_chain_var (#match? @_emit_chain_var "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var
`;

// Extra JSX-specific queries — appended for .tsx/.jsx files (TSX grammar only)
export const JSX_EXTRA_QUERIES = `
; JSX component render: <Component /> — treated as CALLS from parent to component
(jsx_self_closing_element
  name: (identifier) @call.name) @call

; JSX component render: <Component>...</Component>
(jsx_opening_element
  name: (identifier) @call.name) @call

; JSX member expression: <Foo.Bar />
(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @call.name)) @call

; JSX Provider: <Ctx.Provider value={...}> — component provides context data
(jsx_opening_element
  name: (member_expression
    object: (identifier) @context.provider.name
    property: (property_identifier) @_prov (#eq? @_prov "Provider"))) @context.provider
`;

// JavaScript queries - works with tree-sitter-javascript
export const JAVASCRIPT_QUERIES = `
(class_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; JSX component render: <Component /> — treated as CALLS from parent to component
(jsx_self_closing_element
  name: (identifier) @call.name) @call

; JSX component render: <Component>...</Component>
(jsx_opening_element
  name: (identifier) @call.name) @call

; JSX member expression: <Foo.Bar />
(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @call.name)) @call

; Class fields — field_definition captures JS class fields (class User { address = ... })
(field_definition
  property: (property_identifier) @name) @definition.property

; Heritage queries - class extends (JavaScript uses different AST than TypeScript)
; In tree-sitter-javascript, class_heritage directly contains the parent identifier
(class_declaration
  name: (identifier) @heritage.class
  (class_heritage
    (identifier) @heritage.extends)) @heritage

; Write access: obj.field = value
(assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; HTTP consumers: fetch('/path'), axios.get('/path'), $.get('/path'), etc.
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url])) @route.fetch

; axios.get/post, $.get/post/ajax
(call_expression
  function: (member_expression
    property: (property_identifier) @http_client.method)
  arguments: (arguments
    (string (string_fragment) @http_client.url))) @http_client

; Express/Hono route registration
(call_expression
  function: (member_expression
    property: (property_identifier) @express_route.method)
  arguments: (arguments
    (string (string_fragment) @express_route.path))) @express_route

; ── React Context captures ────────────────────────────────────────────────

; useContext consumer: useContext(ContextName)
(call_expression
  function: (identifier) @_uc_js (#eq? @_uc_js "useContext")
  arguments: (arguments
    .
    (identifier) @context.consumed)) @context.consumer

; JSX Provider: <Ctx.Provider value={...}>
(jsx_opening_element
  name: (member_expression
    object: (identifier) @context.provider.name
    property: (property_identifier) @_prov_js (#eq? @_prov_js "Provider"))) @context.provider

; ── Message channel captures (Socket.IO, EventEmitter) ────────────────────

; Socket.IO / EventEmitter listener: socket.on('event', fn), emitter.on('event', fn)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_method (#match? @_on_method "^(on|once)$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer.socket

; Socket.IO/EventEmitter listener via this: this.socket.on('event', fn)
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_on_method_this (#match? @_on_method_this "^(on|once)$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.consumer.socket

; Socket.IO / EventEmitter emit: socket.emit('event', data), emitter.emit('event', data)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_method (#match? @_emit_method "^emit$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer.socket

; Socket.IO/EventEmitter emit via this: this.socket.emit('event', data)
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_emit_method_this (#match? @_emit_method_this "^emit$"))
  arguments: (arguments
    (string (string_fragment) @channel.name))) @channel.producer.socket

; ── Variable channel name captures (const/identifier first arg) ───────────

; socket.on(VARIABLE, fn) — identifier as first arg (const variable)
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_var_js (#match? @_on_var_js "^(on|once)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; this.socket.on(VARIABLE, fn) — via this
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_on_var2_js (#match? @_on_var2_js "^(on|once)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; socket.emit(VARIABLE, data) — identifier as first arg
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_var_js (#match? @_emit_var_js "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var

; this.socket.emit(VARIABLE, data) — via this
(call_expression
  function: (member_expression
    object: (member_expression
      object: (this)
      property: (property_identifier) @channel.object)
    property: (property_identifier) @_emit_var2_js (#match? @_emit_var2_js "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var

; socket.on(OBJ.PROP, fn) — member expression as first arg
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_on_member_js (#match? @_on_member_js "^(on|once)$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.consumer.socket.member

; socket.emit(OBJ.PROP, data) — member expression as first arg
(call_expression
  function: (member_expression
    object: (identifier) @channel.object
    property: (property_identifier) @_emit_member_js (#match? @_emit_member_js "^emit$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.producer.socket.member

; getIO().on(OBJ.PROP, fn) — chained call as socket object
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_on_chain_js (#match? @_on_chain_js "^(on|once|off)$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.consumer.socket.member

; getIO().emit(OBJ.PROP, data) — chained call emit
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_emit_chain_js (#match? @_emit_chain_js "^emit$"))
  arguments: (arguments
    .
    (member_expression
      object: (identifier) @channel.ref.obj
      property: (property_identifier) @channel.ref.prop))) @channel.producer.socket.member

; Chained .on(CONST_VAR, handler) — socket.on(...).on(CONST, handler)
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_on_chain_var_js (#match? @_on_chain_var_js "^(on|once|off)$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.consumer.socket.var

; Chained .emit(CONST_VAR, data)
(call_expression
  function: (member_expression
    object: (call_expression)
    property: (property_identifier) @_emit_chain_var_js (#match? @_emit_chain_var_js "^emit$"))
  arguments: (arguments
    .
    (identifier) @channel.name.var)) @channel.producer.socket.var
`;

// Python queries - works with tree-sitter-python
export const PYTHON_QUERIES = `
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(import_statement
  name: (dotted_name) @import.source) @import

; import numpy as np  →  aliased_import captures the module name so the
; import path is resolved and named-binding extraction stores "np" → "numpy".
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.source)) @import

(import_from_statement
  module_name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (relative_import) @import.source) @import

(call
  function: (identifier) @call.name) @call

(call
  function: (attribute
    attribute: (identifier) @call.name)) @call

; Class attribute type annotations — PEP 526: address: Address or address: Address = Address()
; Both bare annotations (address: Address) and annotated assignments (name: str = "test")
; are parsed as (assignment left: ... type: ...) in tree-sitter-python.
(expression_statement
  (assignment
    left: (identifier) @name
    type: (type)) @definition.property)

; Heritage queries - Python class inheritance
(class_definition
  name: (identifier) @heritage.class
  superclasses: (argument_list
    (identifier) @heritage.extends)) @heritage

; Write access: obj.field = value
(assignment
  left: (attribute
    object: (_) @assignment.receiver
    attribute: (identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment
  left: (attribute
    object: (_) @assignment.receiver
    attribute: (identifier) @assignment.property)
  right: (_)) @assignment

; Python HTTP clients: requests.get('/path'), httpx.post('/path'), session.get('/path')
(call
  function: (attribute
    attribute: (identifier) @http_client.method)
  arguments: (argument_list
    (string (string_content) @http_client.url))) @http_client

; Python decorators: @app.route, @router.get, etc.
(decorator
  (call
    function: (attribute
      object: (identifier) @decorator.receiver
      attribute: (identifier) @decorator.name)
    arguments: (argument_list
      (string (string_content) @decorator.arg)?))) @decorator
`;

// Java queries - works with tree-sitter-java
export const JAVA_QUERIES = `
; Classes, Interfaces, Enums, Annotations
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(annotation_type_declaration name: (identifier) @name) @definition.annotation

; Methods & Constructors
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor

; Fields — typed field declarations inside class bodies
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.property

; Imports - capture any import declaration child as source
(import_declaration (_) @import.source) @import

; Calls
(method_invocation name: (identifier) @call.name) @call
(method_invocation object: (_) name: (identifier) @call.name) @call

; Constructor calls: new Foo()
(object_creation_expression type: (type_identifier) @call.name) @call

; Heritage - extends class
(class_declaration name: (identifier) @heritage.class
  (superclass (type_identifier) @heritage.extends)) @heritage

; Heritage - implements interfaces
(class_declaration name: (identifier) @heritage.class
  (super_interfaces (type_list (type_identifier) @heritage.implements))) @heritage.impl

; Write access: obj.field = value
(assignment_expression
  left: (field_access
    object: (_) @assignment.receiver
    field: (identifier) @assignment.property)
  right: (_)) @assignment
`;

// C queries - works with tree-sitter-c
export const C_QUERIES = `
; Functions (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function

; Functions returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Functions returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function

; Structs, Unions, Enums, Typedefs
(struct_specifier name: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.typedef

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
`;

// Go queries - works with tree-sitter-go
export const GO_QUERIES = `
; Functions & Methods
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method

; Types
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

; Imports
(import_declaration (import_spec path: (interpreted_string_literal) @import.source)) @import
(import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @import.source))) @import

; Struct fields — named field declarations inside struct types
(field_declaration_list
  (field_declaration
    name: (field_identifier) @name) @definition.property)

; Struct embedding (anonymous fields = inheritance)
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (struct_type
      (field_declaration_list
        (field_declaration
          type: (type_identifier) @heritage.extends))))) @definition.struct

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call

; Struct literal construction: User{Name: "Alice"}
(composite_literal type: (type_identifier) @call.name) @call

; Write access: obj.field = value
(assignment_statement
  left: (expression_list
    (selector_expression
      operand: (_) @assignment.receiver
      field: (field_identifier) @assignment.property))
  right: (_)) @assignment

; Write access: obj.field++ / obj.field--
(inc_statement
  (selector_expression
    operand: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)) @assignment
(dec_statement
  (selector_expression
    operand: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)) @assignment
`;

// C++ queries - works with tree-sitter-cpp
export const CPP_QUERIES = `
; Classes, Structs, Namespaces
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(enum_specifier name: (type_identifier) @name) @definition.enum

; Typedefs and unions (common in C-style headers and mixed C/C++ code)
(type_definition declarator: (type_identifier) @name) @definition.typedef
(union_specifier name: (type_identifier) @name) @definition.union

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Functions & Methods (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.method

; Functions/methods returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method

; Functions/methods returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))))) @definition.method

; Functions/methods returning references (reference_declarator wraps function_declarator)
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method

; Destructors (destructor_name is distinct from identifier in tree-sitter-cpp)
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (destructor_name) @name))) @definition.method

; Function declarations / prototypes (common in headers)
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Class/struct data member fields (Address address; int count;)
; Uses field_identifier to exclude method declarations (which use function_declarator)
(field_declaration
  declarator: (field_identifier) @name) @definition.property

; Pointer member fields (Address* address;)
(field_declaration
  declarator: (pointer_declarator
    declarator: (field_identifier) @name)) @definition.property

; Reference member fields (Address& address;)
(field_declaration
  declarator: (reference_declarator
    (field_identifier) @name)) @definition.property

; Inline class method declarations (inside class body, no body: void save();)
; tree-sitter-cpp uses field_identifier (not identifier) for names inside class bodies
(field_declaration declarator: (function_declarator declarator: [(field_identifier) (identifier)] @name)) @definition.method

; Inline class method declarations returning a pointer (User* lookup();)
(field_declaration declarator: (pointer_declarator declarator: (function_declarator declarator: [(field_identifier) (identifier)] @name))) @definition.method

; Inline class method declarations returning a reference (User& lookup();)
(field_declaration declarator: (reference_declarator (function_declarator declarator: [(field_identifier) (identifier)] @name))) @definition.method

; Inline class method definitions (inside class body, with body: void Foo() { ... })
(field_declaration_list
  (function_definition
    declarator: (function_declarator
      declarator: [(field_identifier) (identifier) (operator_name) (destructor_name)] @name)) @definition.method)

; Inline class methods returning a pointer type (User* lookup(int id) { ... })
(field_declaration_list
  (function_definition
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: [(field_identifier) (identifier) (operator_name)] @name))) @definition.method)

; Inline class methods returning a reference type (User& lookup(int id) { ... })
(field_declaration_list
  (function_definition
    declarator: (reference_declarator
      (function_declarator
        declarator: [(field_identifier) (identifier) (operator_name)] @name))) @definition.method)

; Templates
(template_declaration (class_specifier name: (type_identifier) @name)) @definition.template
(template_declaration (function_definition declarator: (function_declarator declarator: (identifier) @name))) @definition.template

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier name: (identifier) @call.name)) @call
(call_expression function: (template_function name: (identifier) @call.name)) @call

; Constructor calls: new User()
(new_expression type: (type_identifier) @call.name) @call

; Heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (type_identifier) @heritage.extends)) @heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (access_specifier) (type_identifier) @heritage.extends)) @heritage

; Write access: obj.field = value
(assignment_expression
  left: (field_expression
    argument: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment

`;

// C# queries - works with tree-sitter-c-sharp
export const CSHARP_QUERIES = `
; Types
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(delegate_declaration name: (identifier) @name) @definition.delegate

; Namespaces (block form and C# 10+ file-scoped form)
(namespace_declaration name: (identifier) @name) @definition.namespace
(namespace_declaration name: (qualified_name) @name) @definition.namespace
(file_scoped_namespace_declaration name: (identifier) @name) @definition.namespace
(file_scoped_namespace_declaration name: (qualified_name) @name) @definition.namespace

; Methods & Properties
(method_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.property

; Primary constructors (C# 12): class User(string name, int age) { }
(class_declaration name: (identifier) @name (parameter_list) @definition.constructor)
(record_declaration name: (identifier) @name (parameter_list) @definition.constructor)

; Using
(using_directive (qualified_name) @import.source) @import
(using_directive (identifier) @import.source) @import

; Calls
(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call

; Null-conditional method calls: user?.Save()
; Parses as: invocation_expression → conditional_access_expression → member_binding_expression → identifier
(invocation_expression
  function: (conditional_access_expression
    (member_binding_expression
      (identifier) @call.name))) @call

; Constructor calls: new Foo() and new Foo { Props }
(object_creation_expression type: (identifier) @call.name) @call

; Target-typed new (C# 9): User u = new("x", 5)
(variable_declaration type: (identifier) @call.name (variable_declarator (implicit_object_creation_expression) @call))

; Heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (identifier) @heritage.extends)) @heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (generic_name (identifier) @heritage.extends))) @heritage

; Write access: obj.field = value
(assignment_expression
  left: (member_access_expression
    expression: (_) @assignment.receiver
    name: (identifier) @assignment.property)
  right: (_)) @assignment

; ── Message channel captures (C# EventEmitter, Socket.IO wrapper, events) ─

; C# method call with string first arg: obj.On("event", handler), obj.Emit("event", data)
; Matches EventEmitter.On/Emit, SocketIoWrapper.On/Emit/EmitRequest, etc.
(invocation_expression
  function: (member_access_expression
    expression: (_) @channel.object
    name: (identifier) @channel.method)
  arguments: (argument_list
    (argument (string_literal) @channel.name))) @channel.csharp

; C# method call with const field first arg: _socket.Emit(SOME_CONST, data)
(invocation_expression
  function: (member_access_expression
    expression: (_) @channel.object
    name: (identifier) @channel.method)
  arguments: (argument_list
    .
    (argument (identifier) @channel.name.var))) @channel.csharp.var

; C# generic method call with string first arg: _socket.On<T>("event", handler)
(invocation_expression
  function: (member_access_expression
    expression: (_) @channel.object
    name: (generic_name (identifier) @channel.method))
  arguments: (argument_list
    (argument (string_literal) @channel.name))) @channel.csharp

; C# generic method call with const first arg: _socket.On<T>(CONST, handler)
(invocation_expression
  function: (member_access_expression
    expression: (_) @channel.object
    name: (generic_name (identifier) @channel.method))
  arguments: (argument_list
    .
    (argument (identifier) @channel.name.var))) @channel.csharp.var

; ── C# event/delegate captures ────────────────────────────────────────────

; C# event field declaration: public event EventHandler<T> OnConnected;
(event_field_declaration
  (variable_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.property

; C# event fire: OnConnected?.Invoke(this, args)
(invocation_expression
  function: (conditional_access_expression
    condition: (identifier) @event.fire.name
    (member_binding_expression
      name: (identifier) @_invoke (#eq? @_invoke "Invoke")))
  arguments: (argument_list)) @event.fire

; C# event subscription: obj.OnConnected += handler
(assignment_expression
  left: (member_access_expression
    expression: (_) @event.receiver
    name: (identifier) @event.name)
  "+="
  right: (_) @event.handler) @event.subscribe
`;

// Rust queries - works with tree-sitter-rust
export const RUST_QUERIES = `
; Functions & Items
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name !trait) @definition.impl
(impl_item type: (generic_type type: (type_identifier) @name) !trait) @definition.impl
(mod_item name: (identifier) @name) @definition.module

; Type aliases, const, static, macros
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.const
(static_item name: (identifier) @name) @definition.static
(macro_definition name: (identifier) @name) @definition.macro

; Use statements
(use_declaration argument: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (scoped_identifier name: (identifier) @call.name)) @call
(call_expression function: (generic_function function: (identifier) @call.name)) @call

; Struct literal construction: User { name: value }
(struct_expression name: (type_identifier) @call.name) @call

; Struct fields — named field declarations inside struct bodies
(field_declaration_list
  (field_declaration
    name: (field_identifier) @name) @definition.property)

; Heritage (trait implementation) — all combinations of concrete/generic trait × concrete/generic type
(impl_item trait: (type_identifier) @heritage.trait type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (type_identifier) @heritage.trait type: (generic_type type: (type_identifier) @heritage.class)) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (generic_type type: (type_identifier) @heritage.class)) @heritage

; Write access: obj.field = value
(assignment_expression
  left: (field_expression
    value: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(compound_assignment_expr
  left: (field_expression
    value: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment
`;

// PHP queries - works with tree-sitter-php (php_only grammar)
export const PHP_QUERIES = `
; ── Namespace ────────────────────────────────────────────────────────────────
(namespace_definition
  name: (namespace_name) @name) @definition.namespace

; ── Classes ──────────────────────────────────────────────────────────────────
(class_declaration
  name: (name) @name) @definition.class

; ── Interfaces ───────────────────────────────────────────────────────────────
(interface_declaration
  name: (name) @name) @definition.interface

; ── Traits ───────────────────────────────────────────────────────────────────
(trait_declaration
  name: (name) @name) @definition.trait

; ── Enums (PHP 8.1) ──────────────────────────────────────────────────────────
(enum_declaration
  name: (name) @name) @definition.enum

; ── Top-level functions ───────────────────────────────────────────────────────
(function_definition
  name: (name) @name) @definition.function

; ── Methods (including constructors) ─────────────────────────────────────────
(method_declaration
  name: (name) @name) @definition.method

; ── Class properties (including Eloquent $fillable, $casts, etc.) ────────────
(property_declaration
  (property_element
    (variable_name
      (name) @name))) @definition.property

; Constructor property promotion (PHP 8.0+: public Address $address in __construct)
(method_declaration
  parameters: (formal_parameters
    (property_promotion_parameter
      name: (variable_name
        (name) @name)))) @definition.property

; ── Imports: use statements ──────────────────────────────────────────────────
; Simple: use App\\Models\\User;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @import.source)) @import

; ── Function/method calls ────────────────────────────────────────────────────
; Regular function call: foo()
(function_call_expression
  function: (name) @call.name) @call

; Method call: $obj->method()
(member_call_expression
  name: (name) @call.name) @call

; Nullsafe method call: $obj?->method()
(nullsafe_member_call_expression
  name: (name) @call.name) @call

; Static call: Foo::bar() (php_only uses scoped_call_expression)
(scoped_call_expression
  name: (name) @call.name) @call

; Constructor call: new User()
(object_creation_expression (name) @call.name) @call

; ── Heritage: extends ────────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (base_clause
    [(name) (qualified_name)] @heritage.extends)) @heritage

; ── Heritage: implements ─────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (class_interface_clause
    [(name) (qualified_name)] @heritage.implements)) @heritage.impl

; ── Heritage: use trait (must capture enclosing class name) ──────────────────
(class_declaration
  name: (name) @heritage.class
  body: (declaration_list
    (use_declaration
      [(name) (qualified_name)] @heritage.trait))) @heritage

; PHP HTTP consumers: file_get_contents('/path'), curl_init('/path')
(function_call_expression
  function: (name) @_php_http (#match? @_php_http "^(file_get_contents|curl_init)$")
  arguments: (arguments
    (argument (string (string_content) @http_client.url)))) @http_client

; Write access: $obj->field = value
(assignment_expression
  left: (member_access_expression
    object: (_) @assignment.receiver
    name: (name) @assignment.property)
  right: (_)) @assignment

; Write access: ClassName::$field = value (static property)
(assignment_expression
  left: (scoped_property_access_expression
    scope: (_) @assignment.receiver
    name: (variable_name (name) @assignment.property))
  right: (_)) @assignment
`;

// Ruby queries - works with tree-sitter-ruby
// NOTE: Ruby uses `call` for require, include, extend, prepend, attr_* etc.
// These are all captured as @call and routed in JS post-processing:
//   - require/require_relative → import extraction
//   - include/extend/prepend → heritage (mixin) extraction
//   - attr_accessor/attr_reader/attr_writer → property definition extraction
//   - everything else → regular call extraction
export const RUBY_QUERIES = `
; ── Modules ──────────────────────────────────────────────────────────────────
(module
  name: (constant) @name) @definition.module

; ── Classes ──────────────────────────────────────────────────────────────────
(class
  name: (constant) @name) @definition.class

; ── Instance methods ─────────────────────────────────────────────────────────
(method
  name: (identifier) @name) @definition.method

; ── Singleton (class-level) methods ──────────────────────────────────────────
(singleton_method
  name: (identifier) @name) @definition.method

; ── All calls (require, include, attr_*, and regular calls routed in JS) ─────
(call
  method: (identifier) @call.name) @call

; ── Bare calls without parens (identifiers at statement level are method calls) ─
; NOTE: This may over-capture variable reads as calls (e.g. 'result' at
; statement level). Ruby's grammar makes bare identifiers ambiguous — they
; could be local variables or zero-arity method calls. Post-processing via
; provider.isBuiltInName and symbol resolution filtering suppresses most false
; positives, but a variable name that coincidentally matches a method name
; elsewhere may produce a false CALLS edge.
(body_statement
  (identifier) @call.name @call)

; ── Heritage: class < SuperClass ─────────────────────────────────────────────
(class
  name: (constant) @heritage.class
  superclass: (superclass
    (constant) @heritage.extends)) @heritage

; Write access: obj.field = value (Ruby setter — syntactically a method call to field=)
(assignment
  left: (call
    receiver: (_) @assignment.receiver
    method: (identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment — operator_assignment node, not assignment)
(operator_assignment
  left: (call
    receiver: (_) @assignment.receiver
    method: (identifier) @assignment.property)
  right: (_)) @assignment
`;

// Kotlin queries - works with tree-sitter-kotlin (fwcd/tree-sitter-kotlin)
// Based on official tags.scm; functions use simple_identifier, classes use type_identifier
export const KOTLIN_QUERIES = `
; ── Interfaces ─────────────────────────────────────────────────────────────
; tree-sitter-kotlin (fwcd) has no interface_declaration node type.
; Interfaces are class_declaration nodes with an anonymous "interface" keyword child.
(class_declaration
  "interface"
  (type_identifier) @name) @definition.interface

; ── Classes (regular, data, sealed, enum) ────────────────────────────────
; All have the anonymous "class" keyword child. enum class has both
; "enum" and "class" children — the "class" child still matches.
(class_declaration
  "class"
  (type_identifier) @name) @definition.class

; ── Object declarations (Kotlin singletons) ──────────────────────────────
(object_declaration
  (type_identifier) @name) @definition.class

; ── Companion objects (named only) ───────────────────────────────────────
(companion_object
  (type_identifier) @name) @definition.class

; ── Functions (top-level, member, extension) ──────────────────────────────
(function_declaration
  (simple_identifier) @name) @definition.function

; ── Properties ───────────────────────────────────────────────────────────
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.property

; Primary constructor val/var parameters (data class, value class, regular class)
; binding_pattern_kind contains "val" or "var" — without it, the param is not a property
(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @name) @definition.property

; ── Enum entries ─────────────────────────────────────────────────────────
(enum_entry
  (simple_identifier) @name) @definition.enum

; ── Type aliases ─────────────────────────────────────────────────────────
(type_alias
  (type_identifier) @name) @definition.type

; ── Imports ──────────────────────────────────────────────────────────────
(import_header
  (identifier) @import.source) @import

; ── Function calls (direct) ──────────────────────────────────────────────
(call_expression
  (simple_identifier) @call.name) @call

; ── Method calls (via navigation: obj.method()) ──────────────────────────
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @call.name))) @call

; ── Constructor invocations ──────────────────────────────────────────────
(constructor_invocation
  (user_type
    (type_identifier) @call.name)) @call

; ── Infix function calls (e.g., a to b, x until y) ──────────────────────
(infix_expression
  (simple_identifier) @call.name) @call

; ── Heritage: extends / implements via delegation_specifier ──────────────
; Interface implementation (bare user_type): class Foo : Bar
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (user_type (type_identifier) @heritage.extends))) @heritage

; Class extension (constructor_invocation): class Foo : Bar()
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (constructor_invocation
      (user_type (type_identifier) @heritage.extends)))) @heritage

; Write access: obj.field = value
(assignment
  (directly_assignable_expression
    (_) @assignment.receiver
    (navigation_suffix
      (simple_identifier) @assignment.property))
  (_)) @assignment

`;

// Swift queries - works with tree-sitter-swift
export const SWIFT_QUERIES = `
; Classes
(class_declaration "class" name: (type_identifier) @name) @definition.class

; Structs
(class_declaration "struct" name: (type_identifier) @name) @definition.struct

; Enums
(class_declaration "enum" name: (type_identifier) @name) @definition.enum

; Extensions (mapped to class — no dedicated label in schema)
(class_declaration "extension" name: (user_type (type_identifier) @name)) @definition.class

; Actors
(class_declaration "actor" name: (type_identifier) @name) @definition.class

; Protocols (mapped to interface)
(protocol_declaration name: (type_identifier) @name) @definition.interface

; Type aliases
(typealias_declaration name: (type_identifier) @name) @definition.type

; Functions (top-level and methods)
(function_declaration name: (simple_identifier) @name) @definition.function

; Protocol method declarations
(protocol_function_declaration name: (simple_identifier) @name) @definition.method

; Initializers
(init_declaration) @definition.constructor

; Properties (stored and computed)
(property_declaration (pattern (simple_identifier) @name)) @definition.property

; Enum cases
(enum_entry (simple_identifier) @name) @definition.property

; Imports
(import_declaration (identifier (simple_identifier) @import.source)) @import

; Calls - direct function calls
(call_expression (simple_identifier) @call.name) @call

; Calls - member/navigation calls (obj.method())
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.name))) @call

; Heritage - class/struct/enum inheritance and protocol conformance
(class_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - protocol inheritance
(protocol_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - extension protocol conformance (e.g. extension Foo: SomeProtocol)
; Extensions wrap the name in user_type unlike class/struct/enum declarations
(class_declaration "extension" name: (user_type (type_identifier) @heritage.class)
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Write access: obj.field = value (tree-sitter-swift 0.7.1 uses named fields)
(assignment
  target: (directly_assignable_expression
    (navigation_expression
      target: (_) @assignment.receiver
      suffix: (navigation_suffix
        suffix: (simple_identifier) @assignment.property)))
  result: (_)) @assignment

`;

// Dart queries - works with tree-sitter-dart (UserNobody14/tree-sitter-dart, ABI 14)
// Note: Dart grammar has function_signature/method_signature as wrappers;
// top-level functions are (program > function_signature),
// methods inside classes are (method_signature > function_signature).
// We match top-level functions via (program (function_signature ...)) to avoid
// double-counting methods that also contain function_signature.
export const DART_QUERIES = `
; ── Classes ──────────────────────────────────────────────────────────────────
(class_definition
  name: (identifier) @name) @definition.class

; ── Mixins ───────────────────────────────────────────────────────────────────
(mixin_declaration
  (identifier) @name) @definition.trait

; ── Extensions ───────────────────────────────────────────────────────────────
(extension_declaration
  name: (identifier) @name) @definition.class

; ── Enums ────────────────────────────────────────────────────────────────────
(enum_declaration
  name: (identifier) @name) @definition.enum

; ── Type aliases ─────────────────────────────────────────────────────────────
; Anchor "=" after the name to avoid capturing the RHS type
(type_alias
  (type_identifier) @name
  "=") @definition.type

; ── Top-level functions (parent is program, not method_signature) ────────────
(program
  (function_signature
    name: (identifier) @name) @definition.function)

; ── Abstract method declarations (function_signature inside class body declaration) ──
(declaration
  (function_signature
    name: (identifier) @name)) @definition.method

; ── Methods (inside class/mixin/extension bodies) ────────────────────────────
(method_signature
  (function_signature
    name: (identifier) @name)) @definition.method

; ── Constructors ─────────────────────────────────────────────────────────────
(constructor_signature
  name: (identifier) @name) @definition.constructor

; ── Factory constructors (anchor before param list to capture variant name, not class) ──
(method_signature
  (factory_constructor_signature
    (identifier) @name . (formal_parameter_list))) @definition.constructor

; ── Field declarations (String name = '', Address address = Address()) ──────
(declaration
  (type_identifier)
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name))) @definition.property

; ── Nullable field declarations (String? name) ──────────────────────────────
(declaration
  (nullable_type)
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name))) @definition.property

; ── Getters ──────────────────────────────────────────────────────────────────
(method_signature
  (getter_signature
    name: (identifier) @name)) @definition.property

; ── Setters ──────────────────────────────────────────────────────────────────
(method_signature
  (setter_signature
    name: (identifier) @name)) @definition.property

; ── Imports ──────────────────────────────────────────────────────────────────
(import_or_export
  (library_import
    (import_specification
      (configurable_uri) @import.source))) @import

; ── Calls: direct function/constructor calls (identifier immediately before argument_part) ──
(expression_statement
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: method calls (obj.method()) ───────────────────────────────────────
(expression_statement
  (selector
    (unconditional_assignable_selector
      (identifier) @call.name))) @call

; ── Calls: in return statements (return User()) ─────────────────────────────
(return_statement
  (identifier) @call.name
  (selector (argument_part))) @call

; ── Calls: in variable assignments (var x = getUser()) ──────────────────────
(initialized_variable_definition
  value: (identifier) @call.name
  (selector (argument_part))) @call

; ── Re-exports (export 'foo.dart') ───────────────────────────────────────────
(import_or_export
  (library_export
    (configurable_uri) @import.source)) @import

; ── Write access: obj.field = value ──────────────────────────────────────────
(assignment_expression
  left: (assignable_expression
    (identifier) @assignment.receiver
    (unconditional_assignable_selector
      (identifier) @assignment.property))
  right: (_)) @assignment

; ── Write access: this.field = value ─────────────────────────────────────────
(assignment_expression
  left: (assignable_expression
    (this) @assignment.receiver
    (unconditional_assignable_selector
      (identifier) @assignment.property))
  right: (_)) @assignment

; ── Heritage: extends ────────────────────────────────────────────────────────
(class_definition
  name: (identifier) @heritage.class
  superclass: (superclass
    (type_identifier) @heritage.extends)) @heritage

; ── Heritage: implements ─────────────────────────────────────────────────────
(class_definition
  name: (identifier) @heritage.class
  interfaces: (interfaces
    (type_identifier) @heritage.implements)) @heritage.impl

; ── Heritage: with (mixins) ──────────────────────────────────────────────────
(class_definition
  name: (identifier) @heritage.class
  superclass: (superclass
    (mixins
      (type_identifier) @heritage.trait))) @heritage
`;

import { SupportedLanguages } from '../../config/supported-languages.js';

export const LANGUAGE_QUERIES: Record<SupportedLanguages, string> = {
  [SupportedLanguages.TypeScript]: TYPESCRIPT_QUERIES,
  [SupportedLanguages.JavaScript]: JAVASCRIPT_QUERIES,
  [SupportedLanguages.Python]: PYTHON_QUERIES,
  [SupportedLanguages.Java]: JAVA_QUERIES,
  [SupportedLanguages.C]: C_QUERIES,
  [SupportedLanguages.Go]: GO_QUERIES,
  [SupportedLanguages.CPlusPlus]: CPP_QUERIES,
  [SupportedLanguages.CSharp]: CSHARP_QUERIES,
  [SupportedLanguages.Rust]: RUST_QUERIES,
  [SupportedLanguages.PHP]: PHP_QUERIES,
  [SupportedLanguages.Kotlin]: KOTLIN_QUERIES,
  [SupportedLanguages.Ruby]: RUBY_QUERIES,
  [SupportedLanguages.Swift]: SWIFT_QUERIES,
  [SupportedLanguages.Dart]: DART_QUERIES,
  [SupportedLanguages.Cobol]: '', // Standalone regex processor — no tree-sitter queries
};
