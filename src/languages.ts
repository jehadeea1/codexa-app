export interface LanguageOption {
  id: string;
  label: string;
  extensions: string[];
  category: string;
}

export const languageOptions: LanguageOption[] = [
  { id: 'html', label: 'HTML', extensions: ['html', 'htm', 'xhtml'], category: 'الويب' },
  { id: 'css', label: 'CSS', extensions: ['css'], category: 'الويب' },
  { id: 'javascript', label: 'JavaScript / JSX', extensions: ['js', 'mjs', 'cjs', 'jsx'], category: 'الويب' },
  { id: 'typescript', label: 'TypeScript / TSX', extensions: ['ts', 'tsx'], category: 'الويب' },
  { id: 'vue', label: 'Vue', extensions: ['vue'], category: 'الويب' },
  { id: 'svelte', label: 'Svelte', extensions: ['svelte'], category: 'الويب' },
  { id: 'astro', label: 'Astro', extensions: ['astro'], category: 'الويب' },
  { id: 'php', label: 'PHP — تحرير نصي', extensions: ['php', 'phtml'], category: 'الويب' },
  { id: 'json', label: 'JSON / JSONC', extensions: ['json', 'jsonc'], category: 'البيانات' },
  { id: 'xml', label: 'XML / SVG', extensions: ['xml', 'svg', 'xsd', 'xsl'], category: 'البيانات' },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], category: 'البيانات' },
  { id: 'toml', label: 'TOML', extensions: ['toml'], category: 'البيانات' },
  { id: 'properties', label: 'INI / Properties', extensions: ['ini', 'cfg', 'properties'], category: 'البيانات' },
  { id: 'sql', label: 'SQL', extensions: ['sql', 'ddl', 'dml'], category: 'البيانات' },
  { id: 'protobuf', label: 'Protocol Buffers — تحرير نصي', extensions: ['proto'], category: 'البيانات' },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'markdown', 'mdx'], category: 'المستندات' },
  { id: 'diff', label: 'Diff / Patch', extensions: ['diff', 'patch'], category: 'المستندات' },
  { id: 'python', label: 'Python', extensions: ['py', 'pyw', 'pyi'], category: 'اللغات' },
  { id: 'java', label: 'Java', extensions: ['java'], category: 'اللغات' },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], category: 'اللغات' },
  { id: 'c', label: 'C', extensions: ['c', 'h'], category: 'اللغات' },
  { id: 'cpp', label: 'C++', extensions: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'], category: 'اللغات' },
  { id: 'csharp', label: 'C#', extensions: ['cs'], category: 'اللغات' },
  { id: 'go', label: 'Go', extensions: ['go'], category: 'اللغات' },
  { id: 'rust', label: 'Rust', extensions: ['rs'], category: 'اللغات' },
  { id: 'ruby', label: 'Ruby', extensions: ['rb', 'rake'], category: 'اللغات' },
  { id: 'swift', label: 'Swift', extensions: ['swift'], category: 'اللغات' },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sc'], category: 'اللغات' },
  { id: 'objective-c', label: 'Objective-C', extensions: ['mm'], category: 'اللغات' },
  { id: 'coffeescript', label: 'CoffeeScript', extensions: ['coffee'], category: 'اللغات' },
  { id: 'clojure', label: 'Clojure', extensions: ['clj', 'cljs', 'cljc', 'edn'], category: 'اللغات' },
  { id: 'commonlisp', label: 'Common Lisp / Scheme', extensions: ['lisp', 'lsp', 'scm', 'ss'], category: 'اللغات' },
  { id: 'erlang', label: 'Erlang / Elixir', extensions: ['erl', 'hrl', 'ex', 'exs'], category: 'اللغات' },
  { id: 'haskell', label: 'Haskell', extensions: ['hs', 'lhs'], category: 'اللغات' },
  { id: 'julia', label: 'Julia', extensions: ['jl'], category: 'اللغات' },
  { id: 'lua', label: 'Lua', extensions: ['lua'], category: 'اللغات' },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm'], category: 'اللغات' },
  { id: 'powershell', label: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1'], category: 'اللغات' },
  { id: 'r', label: 'R', extensions: ['r', 'rmd'], category: 'اللغات' },
  { id: 'fortran', label: 'Fortran', extensions: ['f', 'for', 'f90', 'f95', 'f03', 'f08'], category: 'اللغات' },
  { id: 'cobol', label: 'COBOL', extensions: ['cob', 'cbl'], category: 'اللغات' },
  { id: 'pascal', label: 'Pascal', extensions: ['pas', 'pp'], category: 'اللغات' },
  { id: 'groovy', label: 'Groovy', extensions: ['groovy', 'gradle'], category: 'اللغات' },
  { id: 'dart', label: 'Dart — تحرير نصي', extensions: ['dart'], category: 'اللغات' },
  { id: 'matlab', label: 'MATLAB / Octave', extensions: ['m'], category: 'اللغات' },
  { id: 'sass', label: 'Sass / SCSS', extensions: ['sass', 'scss'], category: 'الويب' },
  { id: 'shell', label: 'Shell / Bash', extensions: ['sh', 'bash', 'zsh'], category: 'الأدوات' },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], category: 'الأدوات' },
  { id: 'nginx', label: 'Nginx — تحرير نصي', extensions: ['nginx'], category: 'الأدوات' },
  { id: 'http', label: 'HTTP — تحرير نصي', extensions: ['http'], category: 'الأدوات' },
  { id: 'plaintext', label: 'نص عادي — أي امتداد', extensions: ['txt', 'text', 'log'], category: 'أخرى' },
];

const aliases: Record<string, string> = {
  htm: 'html', xhtml: 'html', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript',
  jsonc: 'json', mdx: 'markdown', pyw: 'python', pyi: 'python', kts: 'kotlin', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', svg: 'xml', yml: 'yaml', bash: 'shell', zsh: 'shell', ex: 'erlang', exs: 'erlang', erl: 'erlang',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', scm: 'commonlisp', ss: 'commonlisp',
  f90: 'fortran', f95: 'fortran', f03: 'fortran', f08: 'fortran', cob: 'cobol', cbl: 'cobol', ps1: 'powershell',
  psd1: 'powershell', psm1: 'powershell', scss: 'sass', rake: 'ruby', rmd: 'r', ddl: 'sql', dml: 'sql',
};

export function detectLanguage(path: string, override?: string | null): string {
  if (override && override !== 'auto') return override;
  const name = path.split('/').at(-1) ?? path;
  const lowerName = name.toLowerCase();
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) return 'dockerfile';
  if (lowerName === 'makefile' || lowerName === 'gnumakefile') return 'shell';
  const extension = lowerName.includes('.') ? lowerName.split('.').at(-1)! : '';
  const direct = languageOptions.find((option) => option.extensions.includes(extension));
  return aliases[extension] ?? direct?.id ?? 'plaintext';
}

export function languageLabel(id: string): string {
  return languageOptions.find((option) => option.id === id)?.label ?? id.toUpperCase();
}
