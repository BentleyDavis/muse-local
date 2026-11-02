export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  css = ""
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (css) node.style.cssText = css;
  return node;
}

export function section(title: string): HTMLElement {
  const container = el("section", "", "margin:14px 0 0;");
  container.append(el("h2", title, "font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9fd0ff;margin:0 0 6px;"));
  return container;
}

export function button(text: string, primary = false, small = false): HTMLButtonElement {
  const control = el("button", text);
  control.style.cssText =
    (small ? "padding:5px 10px;font-size:12px;" : "padding:7px 14px;font-size:13px;") +
    "cursor:pointer;border-radius:6px;border:none;" +
    (primary ? "background:#1d4ed8;color:#fff;" : "background:#2c313a;color:#e8e8e8;");
  return control;
}
