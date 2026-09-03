
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

const shellLang = StreamLanguage.define(shell);

/** CodeMirror-based bash editor with a plain-textarea fallback. */
export function CodeEditor({ value, onChange, height = '62vh' }: { value: string; onChange: (v: string) => void; height?: string }) {
  try {
    return (
      <div className="code-editor">
        <CodeMirror
          value={value}
          height={height}
          theme="dark"
          extensions={[shellLang]}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
          onChange={onChange}
        />
      </div>
    );
  } catch {
    return (
      <textarea
        className="code-textarea" value={value} spellCheck={false}
        onChange={(e) => onChange(e.target.value)} style={{ height }}
      />
    );
  }
}
