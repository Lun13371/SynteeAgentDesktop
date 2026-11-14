/**
 * Shared symbol shapes produced by the Rust sidecar `symbols` command.
 *
 * Kept separate from any parser implementation: the sidecar produces these
 * over the protocol, and TypeScript consumers (read_file outline, memory
 * graph) only need the shape.
 */

export interface SymbolDef {
  name: string
  /** 'function' | 'class' | 'method' | 'variable' | … */
  kind: string
  lineStart: number
  lineEnd: number
  /** First line of the definition. */
  signature: string
  /** Enclosing class/interface/module name, when there is one. */
  parentName?: string
}

export interface FileSymbols {
  definitions: SymbolDef[]
  /** Raw import/include lines. */
  imports: string[]
  /** Identifiers used in the file but not defined there (graph edges). */
  references: string[]
}