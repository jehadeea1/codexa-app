import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';

type Loader = () => Promise<Extension | undefined>;

type GenericState = { inBlockComment: boolean };

function genericSourceMode(id: 'php' | 'dart'): Extension {
  const keywords = new Set(['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typedef', 'var', 'void', 'while', 'yield']);
  return StreamLanguage.define<GenericState>({
    name: `${id}-source`,
    startState: () => ({ inBlockComment: false }),
    token(stream, state) {
      if (state.inBlockComment) {
        if (stream.match('*/')) state.inBlockComment = false;
        else stream.next();
        return 'comment';
      }
      if (stream.eatSpace()) return null;
      if (stream.match('/*')) { state.inBlockComment = true; return 'comment'; }
      if (stream.match(id === 'php' ? /\/\/|#/ : /\/\//)) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/)) return 'string';
      if (id === 'php' && stream.match(/\$[A-Za-z_][\w]*/)) return 'variableName';
      if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
      const word = stream.match(/[A-Za-z_$][\w$]*/);
      if (word && typeof word === 'object') return keywords.has(word[0].toLowerCase()) ? 'keyword' : /^[A-Z]/.test(word[0]) ? 'typeName' : 'variableName';
      stream.next();
      return null;
    },
  });
}

const languages: Record<string, Loader> = {
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  svelte: async () => (await import('@codemirror/lang-html')).html(),
  astro: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  sass: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/sass')).sass),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  protobuf: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  nginx: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/nginx')).nginx),
  http: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/http')).http),
  java: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).java),
  kotlin: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  c: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).c),
  cpp: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).cpp),
  csharp: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  'objective-c': async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).objectiveC),
  'objective-cpp': async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).objectiveCpp),
  scala: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).scala),
  go: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/go')).go),
  yaml: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/yaml')).yaml),
  toml: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
  properties: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
  shell: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  ruby: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  swift: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift),
  coffeescript: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/coffeescript')).coffeeScript),
  clojure: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clojure')).clojure),
  commonlisp: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/scheme')).scheme),
  erlang: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/erlang')).erlang),
  haskell: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/haskell')).haskell),
  julia: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/julia')).julia),
  lua: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua),
  perl: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl),
  powershell: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  r: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/r')).r),
  fortran: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/fortran')).fortran),
  cobol: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/cobol')).cobol),
  pascal: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/pascal')).pascal),
  groovy: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/groovy')).groovy),
  matlab: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/octave')).octave),
  dockerfile: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  diff: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff),
  php: async () => genericSourceMode('php'),
  dart: async () => genericSourceMode('dart'),
};

export async function editorLanguage(id: string): Promise<Extension | undefined> {
  return languages[id]?.();
}
