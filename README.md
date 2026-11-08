<img src="extension/logo.svg" width="72" alt="efferent">

# efferent

Claude in your own browser.

A Chrome extension and a small Rust MCP server that let Claude use the browser it is installed in, in a window of its own, without interrupting you: uploads files in one call, follows "Sign in with Google" through its popup with the accounts you are already signed in to, and is measured on a labelled eval of 18 page shapes that break browser agents, and of every interruption.

Efferent nerves carry commands out from the brain to the muscles. This is that path for a model: Claude Code (or any MCP client) decides, the extension acts, in your own browser with your own sign-ins.

> "Go to my Amazon and find a 6 ft USB-C cable rated 4.5 stars or more, under $10."

Claude opens a tab in a window of its own, behind yours, signed in as you. It searches, sorts and reads the results while you keep typing in whatever you were using. Your keyboard, mouse, tabs and screen stay yours.

## Why an extension

Driving a browser over its debugging port (CDP) needs the browser started with a flag, or a permission prompt, and Chrome shows a "being controlled" bar. An extension you load yourself needs none of that. It is not in the Chrome Web Store and never will be: you load it unpacked, it talks only to `127.0.0.1`, and there is no account and no server.

```
Claude Code ──stdio── efferent MCP server ──ws://127.0.0.1:47800── extension in your browser
```

- The server listens on the first free port from 47800 to 47807, on `127.0.0.1` only, and accepts a connection only from the extension's own origin (`chrome-extension://djkbgokjopagggpagplncnbanmpanhlh`, fixed by the `key` in its manifest). A web page cannot connect to it.
- The extension dials those ports every 2 seconds, so several Claude sessions and several browsers can be connected at once.
- Nothing leaves your computer. The server is one binary under 1 MB with no runtime.

## Install

Needs any Chromium browser 120 or newer: Chrome, Edge, Brave, Arc, Opera, Vivaldi, Thorium.

1. Get the server: download `efferent` for your system from [Releases](https://github.com/brandonmlicea/efferent/releases), or build it with Rust:

   ```sh
   cargo install --git https://github.com/brandonmlicea/efferent
   ```

2. Get the extension folder:

   ```sh
   efferent extension
   ```

   It writes the extension to `~/.efferent/extension` and prints the path. (Or clone this repository and use its `extension` folder.)

3. In your browser open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick that folder.

4. Add the server to Claude Code:

   ```sh
   claude mcp add efferent -s user -- efferent
   ```

   Any other MCP client:

   ```json
   { "mcpServers": { "efferent": { "command": "efferent" } } }
   ```

Optional: on the extension's **Details** page turn on **Allow User Scripts**, so `eval` works on pages whose security policy forbids it without falling back to the debugger.

The toolbar button shows whether a server is connected, lets you rename the browser ("Thorium", "Work Chrome") and has one switch to stop Claude from using it.

## Tools

| Tool | What it does |
| --- | --- |
| `browsers` | Connected browsers by name, with what each has done this session |
| `tabs` | Every tab: Claude's own, and yours, marking the one you used last |
| `open` | An address in a new tab of Claude's own window, answered with the page's elements by ref |
| `read` | A tab's elements by ref. `find` narrows a long page to the elements and lines holding its words (`out of 5 stars \| Add to cart`); `text` adds the page's words |
| `act` | Steps in one call, waiting for the page to settle after each: `click`, `fill` (text, dropdown by option text, checkbox, rich editor), `type`, `press`, `hover`, `scroll`, `upload`, `go`, `back`, `wait` (ms, or text to wait for). A popup a step opens becomes the tab the next steps run in |
| `upload` | Files from this computer into a file field or a drop zone, in one call with no file picker, up to 64 MB each |
| `screenshot` | A picture of a tab |
| `eval` | JavaScript in a tab |
| `close` | Close a tab |

Every tool takes `browser` to pick one by name; `EFFERENT_BROWSER=Thorium` sets the default.

## Signing in

Your browser is already signed in to Google, Apple, Microsoft and GitHub, so Claude never needs a password. A "Sign in with Google" button opens its popup with `window.open`, which Chrome's popup blocker drops on a synthetic click, so efferent clicks buttons named like that (and anything on `accounts.google.com`, including Google's button inside its iframe) with real input. The popup becomes the tab Claude works in, it picks your account, and when the popup closes Claude is back on the page, signed in. The popup window is sent behind yours as soon as it opens.

## How it stays out of your way

- **Its own window.** Pages open in one window of Claude's own, created without focus and never brought to the front. Windows does not let a background app put a window over the one you are using; when you are in the browser itself, efferent raises your window straight back.
- **No focus, no tab switches.** New tabs are created inactive and switched to inside Claude's window, because a tab created active in an unfocused window makes Chrome activate that window.
- **Synthetic input by default.** Clicks, fills and keys are DOM events from the extension's isolated world. They work in a window that is not focused and never touch your real keyboard or mouse. Values go through the native setter, so React and other controlled inputs see them.
- **The debugger only when asked.** `trusted: true` on a step uses `chrome.debugger` for real input on the rare page that checks `event.isTrusted`. While it is attached, Chrome shows a "started debugging this browser" bar; start the browser with `--silent-debugger-extension-api` to hide it.
- **Your tabs stay yours.** Claude never navigates a tab in your window unless it is given that tab.

## The eval

`eval/cases.json` is 15 hand-written cases, each a local page (`eval/pages`) with one shape that breaks browser agents, the steps a model would send, and a check run in the page afterwards. A case passes only when every step ran and the check holds.

| Case | Shape |
| --- | --- |
| `form` | A whole signup form in one call: text, email, dropdown by option text, checkbox, radio, textarea, submit |
| `controlled` | An input that, like React, ignores a value set through the element's own setter |
| `enter` | A search box with no button, submitted by Enter |
| `shadow` | A button inside an open shadow root |
| `editor` | A contenteditable editor with a draft in it, replaced |
| `late` | A button that appears 1.2 s after load |
| `blank` | A `target=_blank` link, which a synthetic click loses to the popup blocker |
| `frame` | A button inside an iframe, by its frame ref |
| `trusted` | A button that only acts on `event.isTrusted` |
| `csp` | `eval` on a page whose CSP forbids eval |
| `tt` | `eval` on a page that requires Trusted Types |
| `lazy` | An infinite feed that loads as its end scrolls into view |
| `listbox` | A custom ARIA combobox that opens on mousedown |
| `hover` | A menu that shows its link only on hover |
| `keys` | A keyboard shortcut the page listens for |
| `upload` | Two files from disk into a multiple file field |
| `drop` | A file dropped on a drop zone with no file field |
| `oauth` | Sign in with Google: a `window.open` popup, an account chooser in it, and back to the page when it closes |

Alongside pass or fail, every case records interruptions:

- **Foreground steals**: the window in front (from the operating system, on Windows) differs before and after the case.
- **Browser focus changes**: any browser window gained focus while efferent was working.
- **Your tab switches**: the active tab of any window that is not Claude's changed.
- **Debugger attaches**: how many times the debugger bar could have shown.

Run it with the extension loaded and the browser open:

```sh
node eval/run.mjs --trials=5
node eval/run.mjs --case=listbox
```

### Results

Thorium 144 on Windows 11 (`eval/runs.jsonl`). The Rust server, 18 cases, 7 November 2026: **18 of 18, median 489 ms, p90 2250 ms**, 0 foreground steals, 0 of your tab switches; the `oauth` popup takes browser focus for a moment before efferent sends it back (2 focus changes, 2 debugger attaches: `trusted` and `oauth`).

The Node server, 5 trials of the first 15 cases (4 November 2026):

| | Passed | Median, p90 | Foreground steals | Browser focus changes | Your tab switches | Debugger attaches |
| --- | --- | --- | --- | --- | --- | --- |
| Run 1 | 75 of 75 | 573 ms, 2309 ms | 0 | 0 | 0 | 5 (the `trusted` case) |
| Run 2 | 75 of 75 | 502 ms, 2279 ms | 0 | 0 | 0 | 5 (the `trusted` case) |
| Development build | 11 of 14 | 505 ms, 3220 ms | 0 | 2 | 0 | 1 |

The development build created Claude's window minimized. A minimized window gives every new site process a 0 by 0 viewport, so pages laid out empty (`listbox`, `lazy`) and the trusted click had nowhere to land; and a tab created active in it brought the window forward. The first two lines of `runs.jsonl` are that build, kept as the record of why the window works the way it does.

Medians include the page settling after each step (load, then 250 ms with no DOM change). `form` and `late` are the slow ones: seven steps, and a 1.2 s wait by design.

### Limits

- 18 cases is small, and I wrote them. They cover the shapes I have hit, not every page. New cases, especially ones it fails, are the most useful contribution.
- One browser and one operating system were measured. The foreground check is Windows only; on macOS and Linux the other three counts still run.
- Synthetic events are not `isTrusted`. Pages that check it need `trusted: true`, and with it the debugger bar unless the browser runs with `--silent-debugger-extension-api`.
- Closed shadow roots are out of reach. A popup window takes focus for a moment before it is sent back.
- It does what it is told in your signed-in browser. Pause it from the toolbar button when you do not want that.

## Developing

`cargo build --release` builds the server, which `eval/client.mjs` runs. Edit the files in `extension/`, then call `browsers` with `reload: true` (or click Reload on `chrome://extensions`). `node eval/client.mjs 'open {"url":"example.com"}' 'read {"find":"more"}'` calls tools from a shell.

## License

MIT
