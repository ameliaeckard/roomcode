// y-codemirror expects to `import CodeMirror from 'codemirror'` as an ES
// module, but CodeMirror 5 is loaded here as a plain global-exposing
// <script> tag (there's no clean CM5 ESM build). This shim just re-exports
// the already-loaded global so the import map can point "codemirror" here.
export default window.CodeMirror;
