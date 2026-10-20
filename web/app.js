const $ = (id) => document.getElementById(id);
let plugins = [],
  active = "",
  workbench,
  config,
  ready = false;
function showLogin() {
  workbench?.disconnectWorkbench();
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("plugin-frame").src = "about:blank";
  ready = false;
}
async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("登录已过期，请重新连接");
  }
  if (!response.ok)
    throw new Error((await response.json()).error || `HTTP ${response.status}`);
  return response.json();
}
function showError(error) {
  const node = active === "workbench" ? $("notice") : $("plugin-error");
  node.textContent = error.message;
  node.hidden = false;
}
async function navigate(id) {
  $("workspace").classList.remove("nav-open");
  if (id === "files") {
    await navigate("workbench");
    workbench.showFiles();
    return;
  }
  const plugin = plugins.find((p) => p.id === id && p.enabled);
  if (!plugin) return;
  active = id;
  history.replaceState(null, "", `#tool=${id}`);
  const native = plugin.type === "native" && id === "workbench";
  $("workbench-sidebar").hidden = !native;
  $("workbench-view").hidden = !native;
  $("plugin-view").hidden = native;
  if (!native) $("file-browser").hidden = true;
  for (const button of $("tool-nav").querySelectorAll("button")) {
    button.classList.toggle("selected", button.dataset.plugin === id);
    button.setAttribute(
      "aria-current",
      button.dataset.plugin === id ? "page" : "false",
    );
  }
  if (native) {
    $("plugin-frame").src = "about:blank";
    if (!workbench) workbench = await import("./workbench.js");
    if (!ready) {
      config = await api("/api/config");
      await workbench.initializeWorkbench(config, {
        api,
        onSessionExpired: showLogin,
      });
      ready = true;
    }
    return;
  }
  $("plugin-title").textContent = plugin.name;
  $("plugin-description").textContent = plugin.description;
  $("plugin-error").hidden = plugin.available;
  $("plugin-error").textContent = plugin.reason;
  $("reload-plugin").disabled = !plugin.available;
  $("plugin-frame").hidden = !plugin.available;
  $("plugin-frame").title = plugin.name;
  $("plugin-frame").src = plugin.available ? plugin.entry : "about:blank";
}
async function enter() {
  [config, { plugins }] = await Promise.all([
    api("/api/config"),
    api("/api/plugins"),
  ]);
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("version").textContent = `v${config.version}`;
  $("tool-nav").replaceChildren();
  for (const plugin of plugins.filter((p) => p.enabled)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.plugin = plugin.id;
    button.className = "tool-link";
    const icon = document.createElement("span");
    icon.textContent = plugin.icon;
    const name = document.createElement("span");
    name.textContent = plugin.name;
    button.append(icon, name);
    if (!plugin.available) {
      const tag = document.createElement("small");
      tag.textContent = "需配置";
      button.append(tag);
    }
    button.title = plugin.description;
    button.addEventListener("click", () =>
      navigate(plugin.id).catch(showError),
    );
    $("tool-nav").append(button);
  }
  const requested = new URLSearchParams(location.hash.slice(1)).get("tool");
  const first = plugins.find((p) => p.enabled && p.available);
  if (!first) {
    $("workbench-sidebar").hidden = true;
    $("workbench-view").hidden = true;
    $("plugin-view").hidden = false;
    $("plugin-title").textContent = "暂无启用的工具";
    $("plugin-description").textContent = "请在配置文件中启用插件后重启服务。";
    $("plugin-frame").hidden = true;
    $("reload-plugin").disabled = true;
    return;
  }
  await navigate(
    plugins.some((p) => p.id === requested && p.enabled)
      ? requested
      : config.activeId &&
          plugins.some((p) => p.id === "workbench" && p.enabled)
        ? "workbench"
        : first.id,
  );
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ token: $("token").value }),
    });
    $("token").value = "";
    await enter();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    showLogin();
  } catch (error) {
    showError(error);
  }
});
for (const button of document.querySelectorAll(".menu-toggle"))
  button.addEventListener("click", () => $("workspace").classList.toggle("nav-open"));
$("scrim").addEventListener("click", () => $("workspace").classList.remove("nav-open"));
$("reload-plugin").addEventListener("click", () => {
  const plugin = plugins.find((p) => p.id === active);
  if (plugin?.available) $("plugin-frame").src = plugin.entry;
});
window.addEventListener("hashchange", () => {
  if ($("workspace").hidden) return;
  const id = new URLSearchParams(location.hash.slice(1)).get("tool");
  if (id && id !== active) navigate(id).catch(showError);
});
// A plugin may notify the shell that its same-origin API session expired.
window.addEventListener("message", async (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== $("plugin-frame").contentWindow
  )
    return;
  if (event.data?.type === "clw:session-expired") {
    showLogin();
    return;
  }
  if (
    active === "claude-history" &&
    event.data?.type === "clw:resume" &&
    typeof event.data.id === "string" &&
    /^[a-f0-9-]{36}$/i.test(event.data.id)
  ) {
    try {
      if (!plugins.some((p) => p.id === "workbench" && p.enabled))
        throw new Error("请先启用任务工作台插件");
      await navigate("workbench");
      await workbench.resumeSession(event.data.id);
    } catch (error) {
      showError(error);
    }
  }
});
// Only fragments are accepted so tokens never reach HTTP or proxy access logs.
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  history.replaceState(null, "", location.pathname);
  $("token").value = token;
  $("login-form").requestSubmit();
} else
  enter().catch((error) => {
    showLogin();
    if (error.message !== "登录已过期，请重新连接")
      $("login-error").textContent = error.message;
  });
