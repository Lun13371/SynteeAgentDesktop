const Parser = require('web-tree-sitter')
Parser.init().then(async () => {
  // Test Python
  const pyLang = await Parser.Language.load('C:/Projects/SynteeHelper/resources/tree-sitter/tree-sitter-python.wasm')
  const pyParser = new Parser()
  pyParser.setLanguage(pyLang)
  const pySrc = "import os\ndef test_something():\n    pass\nclass MyClass:\n    def method(self):\n        return 1"
  const pyTree = pyParser.parse(pySrc)
  const pyRoot = pyTree.rootNode
  console.log('=== Python ===')
  console.log('root:', pyRoot.type, 'children:', pyRoot.children.map(function(c) { return c.type }))
  
  function walk(node, depth) {
    if (depth > 6) return
    console.log('  '.repeat(depth) + node.type)
    if (node.children) {
      node.children.slice(0, 8).forEach(function(c) { walk(c, depth + 1) })
    }
  }
  walk(pyRoot)
  
  // Test TS config file
  const tsLang = await Parser.Language.load('C:/Projects/SynteeHelper/resources/tree-sitter/tree-sitter-typescript.wasm')
  const tsParser = new Parser()
  tsParser.setLanguage(tsLang)
  const tsSrc = "import { defineConfig } from 'electron-vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({})"
  const tsTree = tsParser.parse(tsSrc)
  const tsRoot = tsTree.rootNode
  console.log('\n=== TypeScript ===')
  console.log('root:', tsRoot.type, 'children:', tsRoot.children.map(function(c) { return c.type }))
  walk(tsRoot)
})
