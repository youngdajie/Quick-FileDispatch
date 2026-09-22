/**
 * 语法着色器（零依赖）
 *
 * 为什么自己写而不是引 prism / highlight.js：
 *  - 那两家都是几十万字符的整包，而这个程序的全部自有代码才 0.7 MB，
 *    为「预览几个文本文件」塞一个比自己还大的库不划算；
 *  - CSP 里写了 `script-src 'self'`，外链 CDN 本来也加载不进来；
 *  - 我们只要「看得清结构」，不需要逐语言 100% 精确的词法。
 *
 * 输出约定：一段 HTML 串，每个记号包一层 <span class="hl-xxx">，
 * 颜色全部交给 app.css 的 --hl-* 变量，深浅两套主题各自定义。
 *
 * 安全性：所有原文片段一律经过 escapeHtml 才会拼进结果 —— 着色器输出会被
 * innerHTML 塞进预览框，任何一个漏转义的 '<' 都等于给自己开个注入口子。
 * 顶层还有 try/catch 兜底：万一某个语言分支炸了，退回纯转义文本，
 * 预览框宁可没颜色，也不能白屏。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CPHighlight = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------ 基础工具 */

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ESC_MAP[c]);
  }

  /** 一个记号 */
  function sp(cls, text) {
    if (text === '' || text == null) return '';
    return '<span class="hl-' + cls + '">' + escapeHtml(text) + '</span>';
  }

  /** 原样输出（空白之类，不需要包 span） */
  function raw(text) {
    return escapeHtml(text);
  }

  function extOf(name) {
    const s = String(name == null ? '' : name);
    const m = /\.([a-z0-9]+)$/i.exec(s);
    if (m) return m[1].toLowerCase();
    const d = /^\.([a-z0-9]+)$/i.exec(s);
    return d ? d[1].toLowerCase() : '';
  }

  const IDENT = /^[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*/;
  const ID_START = /[A-Za-z_$\u00c0-\uffff]/;
  const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)(?:(?:i|u|f)(?:8|16|32|64|128)?|[uUlLfFdD]{1,3}|n)?/;

  /** 读取一个（单行）字符串，返回结束下标 */
  function readStr(code, i) {
    const q = code[i];
    const n = code.length;
    let j = i + 1;
    while (j < n) {
      const ch = code[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === q) return j + 1;
      if (ch === '\n') return j; // 没闭合就别把整个文件吞掉
      j++;
    }
    return n;
  }

  /* ------------------------------------------------------------ 文本文件识别 */

  /** 扩展名 -> 语言 */
  const TEXT_EXT = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
    html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html', hbs: 'html', ejs: 'html',
    css: 'css', scss: 'css', less: 'css', sass: 'css', styl: 'css',
    py: 'py', pyw: 'py', pyi: 'py',
    go: 'go',
    sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', fish: 'sh', ps1: 'sh', psm1: 'sh', bat: 'sh', cmd: 'sh',
    yml: 'yaml', yaml: 'yaml',
    md: 'md', markdown: 'md', mdx: 'md',
    ini: 'ini', conf: 'ini', cfg: 'ini', toml: 'ini', env: 'ini', properties: 'ini', mod: 'ini',
    npmrc: 'ini', editorconfig: 'ini', gitconfig: 'ini', pylintrc: 'ini', prettierrc: 'ini',
    eslintrc: 'ini', babelrc: 'ini', stylelintrc: 'ini', flake8: 'ini',
    gitignore: 'ini', gitattributes: 'ini', gitmodules: 'ini', dockerignore: 'ini', npmignore: 'ini',
    c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', cxx: 'clike', hpp: 'clike', hh: 'clike',
    hxx: 'clike', ino: 'clike',
    cs: 'clike', java: 'clike', kt: 'clike', kts: 'clike', swift: 'clike', dart: 'clike',
    php: 'clike', scala: 'clike', groovy: 'clike', gradle: 'clike',
    rs: 'rs',
    sql: 'sql',
    rb: 'rb', gemfile: 'rb', rakefile: 'rb', podfile: 'rb', brewfile: 'rb', vagrantfile: 'rb',
    txt: 'plain', text: 'plain', log: 'plain', rst: 'plain', csv: 'plain', tsv: 'plain',
    lock: 'plain', sum: 'plain', patch: 'plain', diff: 'plain', srt: 'plain', vtt: 'plain'
  };

  /** 无扩展名的常见文本文件（按整个文件名匹配，小写） */
  const NAME_LANG = {
    dockerfile: 'ini',
    containerfile: 'ini',
    makefile: 'sh',
    gnumakefile: 'sh',
    'cmakelists.txt': 'sh',
    procfile: 'sh',
    'go.mod': 'ini',
    'go.sum': 'plain',
    license: 'plain',
    licence: 'plain',
    notice: 'plain',
    authors: 'plain',
    readme: 'md',
    changelog: 'md',
    contributing: 'md',
    '.bashrc': 'sh',
    '.zshrc': 'sh',
    '.bash_profile': 'sh',
    '.profile': 'sh',
    '.vimrc': 'sh',
    'requirements.txt': 'plain'
  };

  const LANG_LABEL = {
    js: 'JavaScript', ts: 'TypeScript', json: 'JSON', html: 'HTML', css: 'CSS',
    py: 'Python', go: 'Go', sh: 'Shell', yaml: 'YAML', md: 'Markdown',
    ini: '配置', clike: 'C / Java 系', rs: 'Rust', sql: 'SQL', rb: 'Ruby', plain: '纯文本'
  };

  function baseName(name) {
    return String(name == null ? '' : name).split(/[\\/]/).pop().toLowerCase();
  }

  /** 这个文件名能不能当文本预览 */
  function isTextName(name) {
    const base = baseName(name);
    if (!base || base.startsWith('.')) {
      // 点文件走扩展名那条（.gitignore / .env）
      const e = extOf(base);
      if (e === 'gitignore' || e === 'env' || e === 'editorconfig') return true;
    }
    if (NAME_LANG[base]) return true;
    return !!TEXT_EXT[extOf(base)];
  }

  /** 文件名 -> 语言 id（不认识的返回空串） */
  function langOf(name) {
    const base = baseName(name);
    if (NAME_LANG[base]) return NAME_LANG[base];
    return TEXT_EXT[extOf(base)] || '';
  }

  function labelOf(lang) {
    return LANG_LABEL[lang] || '';
  }

  /* ------------------------------------------------------------ 关键词表 */

  const set = (s) => new Set(String(s).split(/[\s,]+/).filter(Boolean));

  const KW = {
    js: set(`const let var function return if else for while do switch case default break continue
      new delete typeof instanceof in of class extends super this static get set async await yield
      try catch finally throw import export from as void with debugger`),
    ts: set(`const let var function return if else for while do switch case default break continue
      new delete typeof instanceof in of class extends super this static get set async await yield
      try catch finally throw import export from as void with debugger
      interface type enum implements declare namespace readonly public private protected abstract
      satisfies keyof infer is asserts override accessor`),
    py: set(`False None True and as assert async await break class continue def del elif else except
      finally for from global if import in is lambda nonlocal not or pass raise return try while with
      yield match case`),
    go: set(`break default func interface select case defer go map struct chan else goto package
      switch const fallthrough if range type continue for import return var`),
    sh: set(`if then else elif fi for in do done while until case esac function select return break
      continue local export readonly declare typeset source alias unalias set unset trap wait exit
      eval exec shift let time`),
    clike: set(`if else for while do switch case default break continue return class struct union enum
      typedef namespace using template public private protected static const constexpr virtual override
      final new delete this super extends implements interface package import throws throw try catch
      finally synchronized volatile transient abstract native goto sizeof extern inline register asm
      operator nullptr NULL true false boolean void`),
    rs: set(`fn let mut const static struct enum trait impl for while loop match if else return break
      continue pub use mod crate super self Self as where move ref dyn unsafe async await in type
      union extern box macro_rules`),
    sql: set(`SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW JOIN LEFT
      RIGHT INNER OUTER FULL ON GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT AS AND OR NOT
      NULL IS IN LIKE BETWEEN EXISTS PRIMARY KEY FOREIGN REFERENCES DEFAULT ALTER DROP TRUNCATE
      GRANT REVOKE COMMIT ROLLBACK TRANSACTION BEGIN END DECLARE CASE WHEN THEN ELSE INT INTEGER
      VARCHAR CHAR TEXT DATE DATETIME TIMESTAMP BOOLEAN FLOAT DOUBLE DECIMAL UNIQUE CHECK CASCADE
      DATABASE IF ASC DESC WITH RENAME ADD COLUMN`),
    rb: set(`def end if elsif else unless while until for in do then begin rescue ensure retry raise
      return break next redo yield class module self nil true false and or not require require_relative
      attr_accessor attr_reader attr_writer include extend puts lambda proc new case when`),
    yaml: set('true false null yes no on off')
  };

  const TYPES = {
    go: set(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
      string uint uint8 uint16 uint32 uint64 uintptr any`),
    sql: set('')
  };

  const BUILTINS = {
    js: set(`console process window document globalThis require module exports __dirname __filename
      Buffer fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask
      localStorage sessionStorage navigator location history alert confirm prompt`),
    py: set(`print len range str int float list dict set tuple bool bytes bytearray type isinstance
      issubclass super open enumerate zip map filter sorted reversed sum min max abs round any all
      input format repr id hash iter next getattr setattr hasattr delattr dir vars globals locals
      divmod pow hex oct bin chr ord self cls Exception ValueError TypeError KeyError IndexError
      StopIteration RuntimeError AttributeError ImportError FileNotFoundError OSError ZeroDivisionError`),
    go: set(`append cap close complex copy delete imag len make new panic print println real recover
      min max clear true false nil iota`),
    sh: set(`echo printf cd pwd ls cat touch mkdir rmdir rm cp mv ln chmod chown grep sed awk head
      tail sort uniq wc find xargs which whereis whoami date sleep curl wget tar zip unzip gzip git
      npm pnpm yarn node python pip sudo apt yum dnf brew docker kill pkill ps df du free top env
      test expr basename dirname read tr cut paste tee diff patch make ssh scp rsync systemctl
      service true false $? $@ $# $* $$ $!`),
    rb: set('puts p require require_relative attr_accessor attr_reader attr_writer new print gets')
  };

  /* ------------------------------------------------------------ 语言配置 */

  function cfgFor(lang) {
    const base = {
      line: ['//'],
      block: [['/*', '*/']],
      quotes: ['"', "'"],
      keywords: KW.clike,
      types: TYPES.clike,
      builtins: BUILTINS.clike,
      funcCall: true,
      capType: false,
      regex: false,
      dollar: false,
      strPrefix: false,
      decorator: false
    };

    switch (lang) {
      case 'js':
        return Object.assign({}, base, {
          keywords: KW.js, builtins: BUILTINS.js, types: null, capType: true,
          regex: true, backtick: true
        });
      case 'ts':
        return Object.assign({}, base, {
          keywords: KW.ts, builtins: BUILTINS.js, types: null, capType: true,
          regex: true, backtick: true
        });
      case 'json':
        return {
          line: [], block: [], quotes: ['"'], keywords: null, types: null, builtins: set('true false null'),
          funcCall: false, jsonKey: true
        };
      case 'py':
        return Object.assign({}, base, {
          line: ['#'], block: null, keywords: KW.py, builtins: BUILTINS.py, types: null,
          triple: true, decorator: true, strPrefix: true, capType: true
        });
      case 'go':
        return Object.assign({}, base, {
          keywords: KW.go, types: TYPES.go, builtins: BUILTINS.go, backtick: true, capType: false
        });
      case 'sh':
        return Object.assign({}, base, {
          line: ['#'], block: null, keywords: KW.sh, builtins: BUILTINS.sh,
          types: null, dollar: true, capType: false, funcCall: false
        });
      case 'rs':
        return Object.assign({}, base, {
          keywords: KW.rs, builtins: set('Some None Ok Err Box Vec String'), capType: true, decorator: true
        });
      case 'sql':
        return Object.assign({}, base, {
          line: ['--'], keywords: KW.sql, types: null, builtins: null, capType: false, funcCall: true
        });
      case 'clike':
        return Object.assign({}, base, { capType: true, decorator: true });
      default:
        return base;
    }
  }

  /* ------------------------------------------------------------ 通用扫描器 */

  const MAX_HL = 400000; // 超过这个长度就不着色了：逐字符扫描会明显拖慢界面

  function genericScan(code, cfg) {
    const c = cfg || {};
    const out = [];
    const n = code.length;
    let i = 0;
    let last = ''; // 上一个有意义的记号：决定 '/' 是正则还是除号

    while (i < n) {
      const ch = code[i];

      // 空白原样输出
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        let j = i + 1;
        while (j < n && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
        out.push(raw(code.slice(i, j)));
        i = j;
        continue;
      }

      // 块注释
      if (c.block) {
        let hit = false;
        for (const pair of c.block) {
          if (code.startsWith(pair[0], i)) {
            const end = pair[1] ? code.indexOf(pair[1], i + pair[0].length) : -1;
            const stop = end < 0 ? n : end + pair[1].length;
            out.push(sp('cmt', code.slice(i, stop)));
            i = stop;
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }

      // 行注释
      if (c.line && c.line.length) {
        let hit = false;
        for (const lc of c.line) {
          if (code.startsWith(lc, i)) {
            let end = code.indexOf('\n', i);
            if (end < 0) end = n;
            out.push(sp('cmt', code.slice(i, end)));
            i = end;
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }

      // Python 三引号
      if (c.triple && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
        const q = code.slice(i, i + 3);
        let end = code.indexOf(q, i + 3);
        end = end < 0 ? n : end + 3;
        out.push(sp('str', code.slice(i, end)));
        i = end;
        last = 'str';
        continue;
      }

      // Python 字符串前缀 r"..." / f"..." / b'...'
      if (c.strPrefix && /^[A-Za-z]{1,2}["']/.test(code.slice(i, i + 3))) {
        const m = /^([A-Za-z]{1,2})(["'])/.exec(code.slice(i));
        if (/^(r|b|f|u|rb|br|fr|rf)$/i.test(m[1])) {
          out.push(sp('kw', m[1]));
          i += m[1].length;
          continue;
        }
      }

      // JSON 的键：字符串后面跟冒号
      if (c.jsonKey && ch === '"') {
        const end = readStr(code, i);
        let k = end;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        out.push(sp(code[k] === ':' ? 'prop' : 'str', code.slice(i, end)));
        i = end;
        last = 'str';
        continue;
      }

      // 模板串
      if (c.backtick && ch === '`') {
        i = readTemplate(code, i, out, c);
        last = 'str';
        continue;
      }

      // 字符串
      if (c.quotes && c.quotes.indexOf(ch) >= 0) {
        const end = readStr(code, i);
        out.push(sp('str', code.slice(i, end)));
        i = end;
        last = 'str';
        continue;
      }

      // 变量 $FOO / ${FOO} / $1
      if (c.dollar && ch === '$') {
        const m = /^\$(?:\{[A-Za-z_][\w]*\}|[A-Za-z_][\w]*|[0-9@*#?!$])/.exec(code.slice(i));
        if (m) {
          out.push(sp('var', m[0]));
          i += m[0].length;
          last = 'id';
          continue;
        }
      }

      // 数字
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
        const m = NUM_RE.exec(code.slice(i));
        if (m && m[0]) {
          out.push(sp('num', m[0]));
          i += m[0].length;
          last = 'num';
          continue;
        }
      }

      // 装饰器 / 注解 @Foo
      if (c.decorator && ch === '@' && ID_START.test(code[i + 1] || '')) {
        const m = IDENT.exec(code.slice(i + 1));
        out.push(sp('kw', '@' + m[0]));
        i += 1 + m[0].length;
        last = 'kw';
        continue;
      }

      // 标识符
      if (ID_START.test(ch)) {
        const m = IDENT.exec(code.slice(i));
        const w = m[0];
        const end = i + w.length;
        let cls = '';
        if (c.keywords && c.keywords.has(w)) cls = 'kw';
        else if (c.builtins && c.builtins.has(w)) cls = 'builtin';
        else if (c.types && c.types.has(w)) cls = 'tp';
        else if (c.capType && /^[A-Z]/.test(w)) cls = 'tp';
        if (!cls && c.funcCall) {
          let k = end;
          while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
          if (code[k] === '(') cls = 'fn';
        }
        out.push(cls ? sp(cls, w) : raw(w));
        i = end;
        last = cls === 'kw' ? 'kw' : 'id';
        continue;
      }

      // 正则字面量（只有在「表达式位置」才当正则，否则 a / b 会被误吃）
      if (ch === '/' && c.regex && (last === '' || last === 'op' || last === 'kw')) {
        const r = readRegex(code, i);
        if (r) {
          out.push(sp('reg', r));
          i += r.length;
          last = 'num';
          continue;
        }
      }

      // 运算符
      if (/[+\-*/%=<>!&|^~?:]/.test(ch)) {
        let j = i;
        while (j < n && /[+\-*/%=<>!&|^~?:]/.test(code[j])) j++;
        out.push(sp('op', code.slice(i, j)));
        i = j;
        last = 'op';
        continue;
      }

      // 括号与分隔符
      if (/[(){}\[\],;.]/.test(ch)) {
        out.push(sp('op', ch));
        i++;
        last = 'op';
        continue;
      }

      out.push(raw(ch));
      i++;
      last = '';
    }

    return out.join('');
  }

  function readTemplate(code, i, out, cfg) {
    const n = code.length;
    let j = i + 1;
    let buf = '`';
    while (j < n) {
      const ch = code[j];
      if (ch === '\\') {
        buf += code.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === '`') {
        buf += '`';
        out.push(sp('str', buf));
        return j + 1;
      }
      if (ch === '$' && code[j + 1] === '{') {
        // 先把配对的花括号找出来。找不到就当普通文本 —— 否则会凭空补一个 '}'
        let depth = 1;
        let k = j + 2;
        let closed = false;
        while (k < n) {
          const d = code[k];
          if (d === '{') depth++;
          else if (d === '}') {
            depth--;
            if (depth === 0) {
              closed = true;
              break;
            }
          }
          k++;
        }
        if (!closed) {
          buf += code.slice(j);
          j = n;
          break;
        }
        out.push(sp('str', buf));
        buf = '';
        out.push(sp('op', '${'));
        out.push(genericScan(code.slice(j + 2, k), cfg));
        out.push(sp('op', '}'));
        j = k + 1;
        continue;
      }
      buf += ch;
      j++;
    }
    out.push(sp('str', buf));
    return j;
  }

  /** 尽量保守：找得到闭合斜杠才算正则，找不到就当除号交给调用方 */
  function readRegex(code, i) {
    const n = code.length;
    if (code[i + 1] === '/' || code[i + 1] === '*' || code[i + 1] === ' ') return null;
    let j = i + 1;
    let inClass = false;
    let body = '';
    while (j < n) {
      const ch = code[j];
      if (ch === '\\') {
        body += code.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === '\n') return null;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        const m = /^[gimsuyd]*/.exec(code.slice(j + 1));
        if (!body) return null;
        return code.slice(i, j + 1 + m[0].length);
      }
      body += ch;
      j++;
    }
    return null;
  }

  /* ------------------------------------------------------------ HTML */

  const VOID_TAG = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

  function htmlScan(code) {
    const out = [];
    const n = code.length;
    let i = 0;

    while (i < n) {
      if (code.startsWith('<!--', i)) {
        let end = code.indexOf('-->', i + 4);
        end = end < 0 ? n : end + 3;
        out.push(sp('cmt', code.slice(i, end)));
        i = end;
        continue;
      }
      if (code.startsWith('<!', i) || code.startsWith('<?', i)) {
        let end = code.indexOf('>', i);
        end = end < 0 ? n : end + 1;
        out.push(sp('kw', code.slice(i, end)));
        i = end;
        continue;
      }
      if (code[i] === '<' && /[A-Za-z/]/.test(code[i + 1] || '')) {
        let j = i + 1;
        let quote = '';
        let end = -1;
        while (j < n) {
          const ch = code[j];
          if (quote) {
            if (ch === quote) quote = '';
            j++;
            continue;
          }
          if (ch === '"' || ch === "'") {
            quote = ch;
            j++;
            continue;
          }
          if (ch === '>') {
            end = j;
            break;
          }
          j++;
        }
        if (end < 0) {
          out.push(raw(code.slice(i)));
          break;
        }
        const rawTag = code.slice(i, end + 1);
        out.push(renderTag(rawTag));
        i = end + 1;

        const m = /^<\s*([A-Za-z][\w:-]*)/.exec(rawTag);
        const tag = m ? m[1].toLowerCase() : '';
        const selfClose = /\/\s*>$/.test(rawTag);
        if ((tag === 'script' || tag === 'style') && !selfClose) {
          const closeRe = new RegExp('<\\/\\s*' + tag + '\\s*>', 'i');
          const rest = code.slice(i);
          const cm = closeRe.exec(rest);
          const bodyEnd = cm ? i + cm.index : n;
          const body = code.slice(i, bodyEnd);
          if (tag === 'style') {
            out.push(cssScan(body));
          } else {
            const tm = /type\s*=\s*["']([^"']*)["']/i.exec(rawTag);
            const isJs = !tm || !tm[1] || /javascript|module|ecmascript|babel|jsx/i.test(tm[1]);
            out.push(isJs ? genericScan(body, cfgFor('js')) : raw(body));
          }
          i = bodyEnd;
          if (cm) {
            out.push(sp('op', cm[0]));
            i = bodyEnd + cm[0].length;
          }
        }
        continue;
      }

      let j = i;
      while (j < n && code[j] !== '<') j++;
      // 走到这里说明当前就是个 '<'，但它没构成标签（比如正文里的 `a < b`、
      // 或者没写完的半截标签）。**必须吃掉一个字符保证前进** —— 早先直接
      // `i = j` 会让 i 原地不动，转成死循环：界面卡住十几秒，直到数组撑爆
      // 抛 RangeError 被兜底吞掉，最后表现为「这个 HTML 不着色」。
      if (j === i) {
        out.push(raw(code[i]));
        i++;
        continue;
      }
      const text = code.slice(i, j);
      // 实体也照样转义后上色 —— 这是「看源码」，不是渲染网页，
      // 把 &nbsp; 显示成空格反而会让人以为文件里真的是个空格。
      out.push(
        text
          .split(/(&[a-zA-Z#0-9]{1,10};)/)
          .map((p, idx) => (idx % 2 ? sp('esc', p) : escapeHtml(p)))
          .join('')
      );
      i = j;
    }

    return out.join('');
  }

  function renderTag(rawTag) {
    let html = '';
    const m = /^(<\/?)([A-Za-z][\w:.-]*)/.exec(rawTag);
    let pos = 0;
    let tagName = '';
    if (m) {
      html += sp('op', m[1]) + sp('tag', m[2]);
      tagName = m[2];
      pos = m[0].length;
    }
    const close = /(\/?>)$/.exec(rawTag);
    const tail = close ? close[1] : '';
    const bodyEnd = rawTag.length - tail.length;
    html += attrsScan(rawTag.slice(pos, bodyEnd));
    if (tail) html += sp('op', tail);
    void VOID_TAG;
    void tagName;
    return html;
  }

  function attrsScan(s) {
    let out = '';
    const re = /([^\s=\/>]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+))?/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out += raw(s.slice(last, m.index));
      out += sp('prop', m[1]);
      if (m[2]) out += sp('op', m[2]);
      if (m[3]) out += /^["']/.test(m[3]) ? sp('str', m[3]) : sp('var', m[3]);
      last = re.lastIndex;
    }
    if (last < s.length) out += raw(s.slice(last));
    return out;
  }

  /* ------------------------------------------------------------ CSS */

  const CSS_VALUE_KW = set(`none auto inherit initial unset revert revert-layer important
    block inline inline-block flex inline-flex grid inline-grid table table-row table-cell
    absolute relative fixed sticky static center left right top bottom middle baseline stretch
    start end space-between space-around space-evenly hidden visible scroll clip
    solid dashed dotted double groove ridge inset outset
    transparent currentColor pointer default move text grab grabbing not-allowed
    nowrap wrap pre pre-wrap break-word break-all ellipsis
    row column row-reverse column-reverse wrap-reverse
    border-box content-box padding-box
    cover contain repeat no-repeat repeat-x repeat-y
    bold normal italic oblique underline uppercase lowercase capitalize
    border-box ease linear ease-in ease-out ease-in-out bolder lighter
    x-small small medium large x-large xx-large`);

  function cssScan(code) {
    const out = [];
    const n = code.length;
    let i = 0;
    let inBlock = false;

    while (i < n) {
      const ch = code[i];
      const slice = () => code.slice(i);

      if (code.startsWith('/*', i)) {
        let end = code.indexOf('*/', i + 2);
        end = end < 0 ? n : end + 2;
        out.push(sp('cmt', code.slice(i, end)));
        i = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = readStr(code, i);
        out.push(sp('str', code.slice(i, end)));
        i = end;
        continue;
      }
      if (ch === '{') {
        out.push(sp('op', '{'));
        inBlock = true;
        i++;
        continue;
      }
      if (ch === '}') {
        out.push(sp('op', '}'));
        inBlock = false;
        i++;
        continue;
      }
      if (ch === '@') {
        const m = /^@[\w-]+/.exec(slice());
        if (m) {
          out.push(sp('kw', m[0]));
          i += m[0].length;
          continue;
        }
      }
      if (ch === '#') {
        const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(slice());
        if (hex) {
          out.push(sp('num', hex[0]));
          i += hex[0].length;
          continue;
        }
        const id = /^#[A-Za-z_][\w-]*/.exec(slice());
        if (id) {
          out.push(sp('var', id[0]));
          i += id[0].length;
          continue;
        }
      }
      if (inBlock) {
        const prop = /^([A-Za-z-][\w-]*)(\s*:)/.exec(slice());
        if (prop) {
          out.push(sp('prop', prop[1]) + sp('op', prop[2]));
          i += prop[0].length;
          continue;
        }
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
        const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?(?:%|[a-zA-Z]{1,4})?/.exec(slice());
        if (m && m[0]) {
          out.push(sp('num', m[0]));
          i += m[0].length;
          continue;
        }
      }
      if (/[A-Za-z_-]/.test(ch)) {
        // `-{0,2}`：CSS 自定义属性（`--gap`）和它的引用（`var(--gap)`）都是以
        // 两个连字符开头的。以前这里只允许一个 `-?`，于是 `var(--gap)` 里那个
        // `-` 会让正则匹配失败、`m` 变成 null，紧接着 `m[0]` 抛异常 ——
        // 异常被 highlight() 的兜底吞掉，整份 CSS（以及含 <style> 的 HTML）
        // 直接退化成不着色的纯文本。这是「HTML / CSS 预览不染色」的真正原因。
        const m = /^-{0,2}[A-Za-z_][\w-]*/.exec(slice());
        if (!m) {
          out.push(raw(ch));
          i++;
          continue;
        }
        const w = m[0];
        const after = code[i + w.length];
        if (after === '(') {
          out.push(sp('fn', w));
          i += w.length;
          continue;
        }
        if (inBlock) {
          if (CSS_VALUE_KW.has(w)) out.push(sp('kw', w));
          else if (after === ':') out.push(sp('prop', w));
          else out.push(sp('var', w));
        } else {
          out.push(sp('tag', w));
        }
        i += w.length;
        continue;
      }
      if (/[.:>&+~*,]/.test(ch) && !inBlock) {
        const m = /^[.:>&+~*,]+/.exec(slice());
        out.push(sp('var', m[0]));
        i += m[0].length;
        continue;
      }
      if (/[(){}\[\]=;]/.test(ch)) {
        out.push(sp('op', ch));
        i++;
        continue;
      }
      out.push(raw(ch));
      i++;
    }

    return out.join('');
  }

  /* ------------------------------------------------------------ Markdown */

  function mdScan(code) {
    const lines = String(code).split('\n');
    const out = [];
    let fence = null;
    let buf = [];

    for (const line of lines) {
      const fm = /^\s*(```|~~~)([^\s`]*)\s*$/.exec(line);
      if (fm) {
        if (!fence) {
          fence = fm[2] || '';
          out.push(sp('kw', line));
          buf = [];
        } else {
          out.push(fence ? highlight(buf.join('\n'), langOfExt(fence)) : raw(buf.join('\n')));
          out.push(sp('kw', line));
          fence = null;
          buf = [];
        }
        continue;
      }
      if (fence) {
        buf.push(line);
        continue;
      }
      out.push(mdLine(line));
    }
    if (fence) out.push(fence ? highlight(buf.join('\n'), langOfExt(fence)) : raw(buf.join('\n')));

    return out.join('\n');
  }

  function mdLine(line) {
    let m;

    if ((m = /^(#{1,6})(\s+.*)$/.exec(line))) {
      return sp('head', m[1]) + sp('head', m[2]);
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      return sp('op', line);
    }
    if ((m = /^(\s*)(>+\s?)(.*)$/.exec(line))) {
      return raw(m[1]) + sp('cmt', m[2]) + sp('cmt', mdInline(m[3]));
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line))) {
      let content = m[4];
      let box = '';
      const bx = /^\[([ xX])\]\s+/.exec(content);
      if (bx) {
        box = sp('kw', bx[0]);
        content = content.slice(bx[0].length);
      }
      return raw(m[1]) + sp('fn', m[2]) + raw(m[3]) + box + mdInline(content);
    }
    return mdInline(line);
  }

  function mdInline(s) {
    const n = s.length;
    let out = '';
    let i = 0;

    while (i < n) {
      const ch = s[i];

      // 图片 ![alt](src)
      if (s.startsWith('![', i)) {
        const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
        if (m) {
          out += sp('op', '![') + sp('var', m[1]) + sp('op', '](') + sp('str', m[2]) + sp('op', ')');
          i += m[0].length;
          continue;
        }
      }
      // 链接 [文字](地址)
      if (ch === '[') {
        const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
        if (m) {
          out += sp('op', '[') + sp('fn', m[1]) + sp('op', '](') + sp('str', m[2]) + sp('op', ')');
          i += m[0].length;
          continue;
        }
      }
      // 行内代码
      if (ch === '`') {
        const tick = /^`+/.exec(s.slice(i))[0];
        const end = s.indexOf(tick, i + tick.length);
        if (end >= 0) {
          out += sp('str', s.slice(i, end + tick.length));
          i = end + tick.length;
          continue;
        }
      }
      // 加粗
      if (s.startsWith('**', i) || s.startsWith('__', i)) {
        const mark = s.slice(i, i + 2);
        const end = s.indexOf(mark, i + 2);
        if (end > i + 2) {
          out += sp('kw', mark) + mdInline(s.slice(i + 2, end)) + sp('kw', mark);
          i = end + 2;
          continue;
        }
      }
      // 斜体
      if (ch === '*' || ch === '_') {
        const end = s.indexOf(ch, i + 1);
        if (end > i + 1) {
          out += sp('var', ch) + mdInline(s.slice(i + 1, end)) + sp('var', ch);
          i = end + 1;
          continue;
        }
      }
      // 自动链接 / 裸标签
      if (ch === '<') {
        const m = /^<[^>\s]{1,200}>/.exec(s.slice(i));
        if (m) {
          out += sp('str', m[0]);
          i += m[0].length;
          continue;
        }
      }

      out += escapeHtml(ch);
      i++;
    }

    return out;
  }

  /** markdown 代码块里写的语言名（js / javascript / ts …）映射到我们的 id */
  function langOfExt(name) {
    const k = String(name || '').toLowerCase();
    const ALIAS = {
      javascript: 'js', js: 'js', node: 'js', mjs: 'js',
      typescript: 'ts', ts: 'ts',
      json: 'json', jsonc: 'json',
      html: 'html', xml: 'html', vue: 'html', svelte: 'html',
      css: 'css', scss: 'css', less: 'css', sass: 'css',
      python: 'py', py: 'py', python3: 'py',
      golang: 'go', go: 'go',
      shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh', console: 'sh', powershell: 'sh',
      yml: 'yaml', yaml: 'yaml',
      md: 'md', markdown: 'md',
      ini: 'ini', toml: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
      java: 'clike', c: 'clike', cpp: 'clike', 'c++': 'clike', cs: 'clike', 'c#': 'clike',
      kotlin: 'clike', swift: 'clike', dart: 'clike', php: 'clike', scala: 'clike',
      rust: 'rs', rs: 'rs',
      sql: 'sql',
      ruby: 'rb', rb: 'rb',
      text: 'plain', txt: 'plain', plain: 'plain', log: 'plain'
    };
    return ALIAS[k] || '';
  }

  /* ------------------------------------------------------------ YAML / INI */

  function yamlScan(code) {
    return String(code)
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('#')) return sp('cmt', line);
        const indent = /^\s*/.exec(line)[0];
        let rest = line.slice(indent.length);
        let lead = '';
        const dash = /^-\s+/.exec(rest);
        if (dash) {
          lead = sp('op', dash[0]);
          rest = rest.slice(dash[0].length);
        }
        const kv = /^([A-Za-z0-9_.\-"'][^:]*?)(\s*:)(\s*)(.*)$/.exec(rest);
        if (kv) {
          return (
            raw(indent) + lead + sp('prop', kv[1]) + sp('op', kv[2]) + raw(kv[3]) + yamlValue(kv[4])
          );
        }
        return raw(indent) + lead + yamlValue(rest);
      })
      .join('\n');
  }

  function yamlValue(v) {
    let comment = '';
    // 引号外的 # 才是注释
    let quote = '';
    let cut = -1;
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '#' && (i === 0 || v[i - 1] === ' ')) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      comment = v.slice(cut);
      v = v.slice(0, cut);
    }
    let body = '';
    if (!v) body = '';
    else if (/^["'].*["']$/.test(v.trim())) body = sp('str', v);
    else if (/^(true|false|null|~|yes|no|on|off)$/i.test(v.trim())) body = sp('builtin', v);
    else if (/^[+-]?\d+(\.\d+)?$/.test(v.trim())) body = sp('num', v);
    else if (/^[*&]/.test(v.trim())) body = sp('var', v);
    else body = sp('str', v);
    return body + (comment ? sp('cmt', comment) : '');
  }

  function iniScan(code) {
    return String(code)
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('#') || trimmed.startsWith(';')) return sp('cmt', line);
        const indent = /^\s*/.exec(line)[0];
        const section = /^\[([^\]]*)\](\s*)$/.exec(trimmed);
        if (section) return raw(indent) + sp('op', '[') + sp('tag', section[1]) + sp('op', ']');
        const kv = /^([^=:#\s][^=:]*?)(\s*[=:]\s*)(.*)$/.exec(trimmed);
        if (kv) {
          return raw(indent) + sp('prop', kv[1]) + sp('op', kv[2]) + yamlValue(kv[3]);
        }
        return raw(indent) + yamlValue(trimmed);
      })
      .join('\n');
  }

  /* ------------------------------------------------------------ 出口 */

  function highlight(code, lang) {
    const id = lang || '';
    const text = String(code == null ? '' : code);
    if (!id || id === 'plain' || text.length > MAX_HL) return escapeHtml(text);
    try {
      switch (id) {
        case 'html':
          return htmlScan(text);
        case 'css':
          return cssScan(text);
        case 'md':
          return mdScan(text);
        case 'yaml':
          return yamlScan(text);
        case 'ini':
          return iniScan(text);
        case 'json':
          return genericScan(text, cfgFor('json'));
        default:
          return genericScan(text, cfgFor(id));
      }
    } catch (e) {
      return escapeHtml(text);
    }
  }

  return {
    escapeHtml,
    extOf,
    isTextName,
    langOf,
    labelOf,
    highlight,
    MAX_HL
  };
});
