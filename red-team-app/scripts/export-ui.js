/* eslint-disable */
/**
 * export-ui.js — copies every HTML file under src/renderer/ into ui-export/
 * with the JS logic stripped out.
 *
 * What's kept:
 *   - Full HTML structure, markup, element ids/classes
 *   - Inline <style> blocks (all CSS)
 *   - External <link> references (fonts, icons)
 *   - External <script src="https://cdn..."> tags for rendering libs
 *     (KaTeX / marked) — without them the <pre>/<code> blocks look broken
 *     if you later re-add rendering
 *
 * What's removed:
 *   - Inline <script>...</script> blocks (the event handlers, IPC calls,
 *     state management — anything that was the "logic")
 *   - <script src="../../dist/..."> references to compiled app code
 *   - .ts / .js files in renderer/* (these were just entry points)
 *
 * Run:
 *   node scripts/export-ui.js
 *
 * Output:
 *   ui-export/  (full tree, ready to open *.html files in a browser)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const DEST = path.join(ROOT, 'ui-export');

function stripScripts(html) {
  // Remove inline scripts (anything with content, no src attribute).
  html = html.replace(
    /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  // Remove scripts pointing to the compiled app bundle in dist/.
  html = html.replace(
    /<script[^>]*src=["'][^"']*dist[^"']*["'][^>]*><\/script>\s*/gi,
    '',
  );
  // Collapse multi-blank lines the removals left behind.
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trimEnd() + '\n';
}

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true });
}
fs.mkdirSync(DEST, { recursive: true });

let stripped = 0;
let skipped = 0;
let copied = 0;

walk(SRC, (file) => {
  const rel = path.relative(SRC, file);
  const dest = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (file.endsWith('.html')) {
    const out = stripScripts(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(dest, out);
    console.log(`[strip] ${rel}`);
    stripped++;
  } else if (file.endsWith('.ts') || file.endsWith('.js')) {
    console.log(`[skip ] ${rel} (logic)`);
    skipped++;
  } else {
    fs.copyFileSync(file, dest);
    console.log(`[copy ] ${rel}`);
    copied++;
  }
});

// Small README so it's clear what each file represents.
const readme = `# Hinty UI export

A static export of the app's renderer UI — HTML + CSS only, all
JavaScript logic stripped.

## Files

| Path | What it is |
|---|---|
| \`general/index.html\` | Main app window — home screen, session history list, session detail view, settings panels (appearance, triggers, hotkeys, knowledge base, profile, billing, support). The biggest file; most of the app's surface area lives here. |
| \`sidepanel/index.html\` | Floating side panel shown over other apps during an active session. Chat-style interface with screenshots, the meeting copilot view (prep / live / summary), quick-action buttons, and the floating control pill (meeting, invisibility, drag handle). |
| \`settings/index.html\` | Legacy standalone settings window (the main UI now uses \`general\` tabs instead). |
| \`overlay/index.html\` | Transparent click-through overlay drawn over whatever app the user is interacting with (used for the emergency-hide and trigger hints). |
| \`auth/index.html\` | Sign-in landing page shown before the user authenticates. |
| \`trayzone/index.html\` | Tiny top-edge hover zone that reveals the floating controls. |

## How the files are meant to be viewed

Each file is self-contained (HTML + inline CSS). Open any of them
directly in a browser to see the layout. A few caveats:

- **Dynamic content shows as empty.** History lists, chat messages, and
  similar views render empty because their contents were injected by
  the JS we stripped.
- **Some visual state needs a class applied manually.** E.g. for the
  sidepanel's "meeting recording" view, inspect and toggle the relevant
  classes (\`meeting-active\`, \`recording\`) on the shell element.
- **CDN rendering libs are kept.** KaTeX and marked are still loaded
  from jsDelivr, so math and markdown rendering will work if you ever
  wire JS back up; without JS they do nothing but also don't break the
  layout.

## Regenerate

\`\`\`
node scripts/export-ui.js
\`\`\`

This wipes and rebuilds \`ui-export/\` from the current \`src/renderer/\`
tree.
`;

fs.writeFileSync(path.join(DEST, 'README.md'), readme);

console.log('');
console.log(`Stripped ${stripped} html · copied ${copied} asset · skipped ${skipped} logic`);
console.log(`Output:  ${path.relative(ROOT, DEST)}/`);
