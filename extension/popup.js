const $ = (id) => document.getElementById(id);

async function show() {
	const s = await chrome.runtime.sendMessage("state");
	$("state").textContent = s.paused ? "Paused." : s.servers ? `Connected to ${s.servers} MCP server${s.servers > 1 ? "s" : ""} on this computer.` : "Waiting for an MCP server on this computer.";
	if (document.activeElement !== $("name")) $("name").value = s.name;
	$("on").checked = !s.paused;
	$("counts").textContent = `${s.calls} calls this session · ${s.focusChanges} focus changes · ${s.debuggerAttaches} debugger attaches`;
}

$("name").addEventListener("input", (e) => chrome.storage.local.set({ name: e.target.value.trim() }));
$("on").addEventListener("change", (e) => chrome.storage.local.set({ paused: !e.target.checked }).then(show));
show();
setInterval(show, 1000);
