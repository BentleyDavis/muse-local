// Async function body: muse and args are supplied by the automation runner.
await muse.navigate("https://messages.google.com/web/conversations");
await muse.log("Waiting up to 60 seconds for Messages conversation summaries to load...");
const deadline = Date.now() + 60000;
let lastState = "";
while (Date.now() < deadline) {
  const summary = await muse.page(() => {
    const isVisible = element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const loadingIndicator = [...document.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], mat-spinner, mat-progress-spinner, mat-progress-bar'
    )].some(isVisible);
    const loadingText = [...document.querySelectorAll('[role="status"], [role="alert"]')]
      .filter(isVisible)
      .some(element => /\b(loading|connecting|reconnecting|syncing|synchronizing|please wait)\b/i.test(element.textContent || ""));
    const conversations = [...document.querySelectorAll("mws-conversation-list-item")];
    const visible = conversations
      .filter(isVisible)
      .map(element => (element.innerText || element.textContent || "").trim())
      .filter(text => text.length > 0);
    return {
      url: location.href,
      title: document.title,
      state: document.readyState !== "complete" || loadingIndicator || loadingText
        ? "loading" : visible.length ? "ready" : "waiting-for-conversations",
      conversations: visible.slice(0, 10),
      note: "Read visible conversation summaries only. No messages opened or sent."
    };
  });
  if (summary.state !== lastState) {
    await muse.log(summary.state === "loading"
      ? "Messages is showing a loading/waiting indicator; waiting for it to finish."
      : summary.state === "ready" ? "Messages conversation list is ready."
      : "No loading indicator or readable conversations yet; still waiting.");
    lastState = summary.state;
  }
  if (summary.state === "ready") {
    const marker = crypto.randomUUID();
    const target = await muse.page(({ marker }) => {
      const rows = [...document.querySelectorAll("mws-conversation-list-item")]
        .filter(element => {
          const style = getComputedStyle(element);
          return element.getClientRects().length > 0 &&
            style.display !== "none" && style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            (element.innerText || element.textContent || "").trim().length > 0;
        });
      const matches = rows.filter(row => {
        const heading = (row.innerText || row.textContent || "").trim().split(/\r?\n/)[0].trim();
        return /^(?:\+?1[\s.-]*)?\(?903\)?[\s.-]*623[\s.-]*3930$/.test(heading);
      });
      if (!matches.length) return null;
      if (matches.length !== 1) throw new Error("Multiple conversations match the requested number; refusing to choose.");
      const row = matches[0];
      row.setAttribute("data-muse-conversation-target", marker);
      return { selector: `[data-muse-conversation-target="${marker}"]`, url: location.href };
    }, { marker });
    if (!target) {
      await muse.wait(500);
      continue;
    }
    try {
      await muse.log("Opening the matching row's context menu, then archiving without opening the conversation.");
      await muse.moveTo({ selector: target.selector });
      const menuTarget = await muse.page(({ selector }) => {
        const row = document.querySelector(selector);
        if (!row) throw new Error("Matching conversation row disappeared.");
        const targets = [...row.querySelectorAll("span.mat-mdc-button-touch-target")]
          .filter(element => {
            const button = element.closest('button, [role="button"]');
            if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
            const labels = ["aria-label", "title", "mattooltip"].map(name => button.getAttribute(name) || "");
            const style = getComputedStyle(element);
            return element.getClientRects().length > 0 && style.visibility !== "hidden" &&
              style.display !== "none" && (button.getAttribute("aria-haspopup") === "menu" ||
                labels.some(label => /^(more options|more conversation options|conversation options|more actions)$/i.test(label.trim())));
          });
        if (targets.length !== 1) throw new Error("Could not uniquely identify the matching row's context-menu touch target.");
        targets[0].setAttribute("data-muse-menu-target", "selected");
        return `${selector} [data-muse-menu-target="selected"]`;
      }, { selector: target.selector });
      await muse.moveTo({ selector: menuTarget });
      await muse.click({ selector: menuTarget });
      let archive = null;
      const archiveDeadline = Date.now() + 30000;
      while (Date.now() < archiveDeadline) {
        archive = await muse.page(({ url, marker }) => {
          if (location.href !== url) throw new Error("Page navigated unexpectedly; archive was not attempted.");
          const visible = element => {
            const style = getComputedStyle(element);
            return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const buttons = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
            .filter(element => visible(element) &&
              !element.disabled && element.getAttribute("aria-disabled") !== "true");
          const labels = element => [
            element.getAttribute("aria-label"), element.getAttribute("title"),
            element.getAttribute("mattooltip"), element.innerText
          ].filter(Boolean).map(text => text.trim());
          const archives = buttons.filter(element => labels(element).some(label =>
            /^(archive|archive conversation|archive this conversation)$/i.test(label)));
          if (archives.length > 1) throw new Error("Multiple Archive controls found; refusing to choose.");
          const element = archives[0];
          if (!element) return null;
          element.setAttribute("data-muse-archive-target", marker);
          return { selector: `[data-muse-archive-target="${marker}"]` };
        }, { url: target.url, marker: crypto.randomUUID() });
        if (!archive) {
          await muse.wait(500);
          continue;
        }
        await muse.moveTo({ selector: archive.selector });
        await muse.click({ selector: archive.selector });
        await muse.page(({ selector }) => {
          document.querySelector(selector)?.removeAttribute("data-muse-archive-target");
        }, { selector: archive.selector });
        break;
      }
      if (!archive) throw new Error("Could not identify Archive in the row's context menu; no archive click performed.");
      const note = "Clicked Archive on the matching conversation using native mouse input. No message was sent.";
      await muse.log(note);
      return { archiveClicked: true, note };
    } finally {
      await muse.page(({ selector }) => {
        const row = document.querySelector(selector);
        row?.querySelector("[data-muse-menu-target]")?.removeAttribute("data-muse-menu-target");
        row?.removeAttribute("data-muse-conversation-target");
      }, { selector: target.selector });
    }
  }
  await muse.wait(500);
}

throw new Error("Timed out waiting for the requested number in loaded conversation rows. No conversation was archived. Check pairing, loading, or whether the conversation is farther down the list.");
