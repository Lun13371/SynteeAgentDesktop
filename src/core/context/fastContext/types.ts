/**
 * Shared symbol shapes for Fast Context.
 *
 * Kept separate from any parser implementation: the Rust sidecar produces these
 * over the protocol, and the remaining TypeScript consumers (snippets, memory
 * graph) only need the shape.
 */

export interface SymbolDef {
  name: string
  /** 'function' | 'class' | 'method' | 'variable' | … */
  kind: string
  lineStart: number
  lineEnd: number
  /** First line of the definition, for repo-map slices. */
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
