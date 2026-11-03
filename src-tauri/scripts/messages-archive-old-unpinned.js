// Async function body supplied with muse. Never opens a conversation.
function matchesCardDate(value) {
  const text = value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ").trim();
  let year, month, day;
  const named = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,?\s+(\d{4}|\d{2}))?$/i.exec(text);
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(text);
  if (named) {
    year = named[3] ? Number(named[3]) : 2000;
    if (named[3]?.length === 2) year += 2000;
    month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
    day = Number(named[2]);
  } else if (numeric) {
    // Messages cards in this session use US M/D/YY; do not guess a locale per row.
    month = Number(numeric[1]); day = Number(numeric[2]); year = Number(numeric[3]);
    if (numeric[3].length === 2) year += 2000;
  } else {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 &&
    date.getDate() === day;
}

function readCard(row) {
  const link = row.querySelector("a[data-e2e-conversation]");
  const timestamp = row.querySelector("mws-relative-timestamp");
  const dates = timestamp ? [...new Set([
    ...[timestamp, ...timestamp.querySelectorAll("*")].flatMap(element =>
      ["datetime", "aria-label", "title"].map(name => element.getAttribute(name))),
    ...(timestamp.innerText || "").split(/\r?\n/),
    timestamp.textContent,
  ].filter(Boolean).map(text => text.trim()).filter(Boolean))] : [];
  return {
    href: link?.getAttribute("href") || "",
    heading: row.querySelector("[data-e2e-conversation-name]")?.textContent.trim() || "",
    unpinned: link?.getAttribute("data-e2e-is-pinned") === "false" &&
      !row.querySelector('[aria-label="Pinned"]'),
    dates,
  };
}

function visible(element) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
  let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
    }
  }
  return right > left && bottom > top;
}

const sources = { read: readCard.toString(), matches: matchesCardDate.toString(), visible: visible.toString() };
const archived = [];
const skipped = new Map();
const url = "https://messages.google.com/web/conversations";
async function loadList() {
  await muse.page(() => { window.__musePreviousLoad = true; }).catch(() => {});
  await muse.navigate(url);
  const loadDeadline = Date.now() + 60000;
  while (!await muse.page(() => !window.__musePreviousLoad && document.readyState === "complete" &&
    Boolean(document.querySelector("mws-conversation-list-item")))) {
    if (Date.now() >= loadDeadline) throw new Error("Conversation list did not load within 60 seconds after page load.");
    await muse.wait(1000);
  }
}
await muse.log("Archive unpinned cards with three-letter month dates or M/D/YY dates, regardless of age. Confirmation required for the first five archives this run; automatic afterward.");
await loadList();
let refreshedPass = false;
let archivedAtRefresh = 0;

async function validate(match) {
  await muse.page(({ match, sources, url }) => {
    if (location.href !== url) throw new Error("Page changed; refusing archive.");
    const read = new Function(`return (${sources.read})`)();
    const matchesDate = new Function(`return (${sources.matches})`)();
    const rows = [...document.querySelectorAll("mws-conversation-list-item")]
      .filter(row => read(row).href === match.href);
    if (rows.length !== 1) throw new Error("Conversation missing or ambiguous.");
    const current = read(rows[0]);
    if (!current.unpinned || current.heading !== match.heading ||
        JSON.stringify(current.dates) !== JSON.stringify(match.dates)) {
      throw new Error("Conversation identity, pin status, or date changed; stopping.");
    }
    if (!current.dates.some(matchesDate)) throw new Error("Conversation date does not match the archive rule.");
  }, { match, sources, url });
}

async function pointFor(selector) {
  for (let poll = 0; poll <= 10; poll++) {
    const result = await muse.page(({ selector, source }) => {
    const vis = new Function(`return (${source})`)();
    const elements = [...document.querySelectorAll(selector)].filter(vis);
    if (elements.length !== 1) {
      throw new Error(`Pointer target ${selector}: expected one visible element, found ${elements.length}.`);
    }
    const element = elements[0], rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
    }
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    if (left >= right || top >= bottom || !element.contains(hit)) {
      return { error: `Pointer target ${selector} is clipped or covered by ${hit?.tagName || "no element"}.` };
    }
    if (element.getAnimations({ subtree: true }).some(animation => animation.playState === "running") ||
        [...element.parentElement?.getAnimations() || []].some(animation => animation.playState === "running")) {
      return { error: `Pointer target ${selector} is still animating.` };
    }
    return { point };
  }, { selector, source: sources.visible });
    if (result.point) return result.point;
    if (poll === 10) throw new Error(`${result.error} Stopping after ten seconds without a safe target.`);
    if (poll === 0) await muse.log(`${result.error} Checking once per second for up to ten seconds.`);
    await muse.wait(1000);
  }
}

let pixelsPerNotch = null;
while (true) {
  const scan = await muse.page(({ sources, url }) => {
    if (location.href !== url) throw new Error("Left conversation list.");
    const read = new Function(`return (${sources.read})`)();
    const matchesDate = new Function(`return (${sources.matches})`)();
    const vis = new Function(`return (${sources.visible})`)();
    const skipped = [];
    for (const row of document.querySelectorAll("mws-conversation-list-item")) {
      if (!vis(row)) continue;
      const card = read(row);
      let reason = "";
      if (!card.href || !card.heading) reason = "missing conversation identity";
      else if (!card.unpinned) reason = "pinned or pin status unknown";
      else if (!card.dates.some(matchesDate)) reason = "not a three-letter month date or M/D/YY date";
      if (reason) { skipped.push({ ...card, reason }); continue; }
      const marker = "old-" + Math.random().toString(36).slice(2);
      row.setAttribute("data-muse-old", marker);
      return { match: { ...card, marker }, skipped };
    }
    return { match: null, skipped };
  }, { sources, url });
  for (const card of scan.skipped) {
    if (skipped.has(card.href)) continue;
    skipped.set(card.href, card.reason);
    await muse.log({ skipped: card.heading, dates: card.dates, reason: card.reason });
  }
  if (scan.match) {
    const match = scan.match;
    if (archived.includes(match.href)) throw new Error("Previously archived conversation reappeared; stopping.");
    await validate(match);
    for (let attempt = 0; attempt < 40; attempt++) {
      const position = await muse.page(({ marker, pixelsPerNotch }) => {
        const row = document.querySelector(`[data-muse-old="${marker}"]`);
        if (!row) throw new Error("Conversation disappeared while positioning.");
        let container = row.parentElement;
        while (container && !(/^(auto|scroll)$/.test(getComputedStyle(container).overflowY) &&
          container.scrollHeight > container.clientHeight + 2)) container = container.parentElement;
        if (!container) throw new Error("Cannot identify list bounds for safe row positioning.");
        const bounds = container.getBoundingClientRect(), rect = row.getBoundingClientRect();
        const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
        const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
        if (top >= bottom || left >= right) throw new Error("List not visible while positioning.");
        const center = (rect.top + rect.bottom) / 2;
        const middle = Math.max(top, Math.min(bottom, innerHeight / 2));
        const offset = center - middle;
        const tolerance = Math.max(rect.height / 2, 40, (pixelsPerNotch || 0) / 2 + 2);
        const direction = Math.abs(offset) <= tolerance ? 0 : offset > 0 ? -1 : 1;
        return { direction, offset,
          blocked: direction < 0
            ? container.scrollTop + container.clientHeight >= container.scrollHeight - 2
            : container.scrollTop <= 0,
          point: { x: (left + right) / 2, y: (top + bottom) / 2 } };
      }, { marker: match.marker, pixelsPerNotch });
      if (!position.direction) break;
      if (position.blocked) {
        await muse.log("Row is at a list boundary and cannot reach the middle; coverage checks still apply.");
        break;
      }
      if (attempt === 39) throw new Error("Could not center conversation after native scrolling; stopping.");
      const ticks = pixelsPerNotch === null ? 1 :
        Math.max(1, Math.min(6, Math.floor(Math.abs(position.offset) / pixelsPerNotch)));
      await muse.log(`Centering conversation in the window: ${Math.round(position.offset)} px from middle; wheel ${position.direction * ticks}.`);
      await muse.moveTo({ to: position.point });
      await muse.scroll(position.direction * ticks);
      await muse.wait(300);
      await validate(match);
    }
    await muse.log(`Eligible: ${match.heading}; card dates: ${match.dates.join(" / ")}. Hovering over row to reveal options.`);
    await muse.moveTo({ to: await pointFor(`[data-muse-old="${match.marker}"] .text-content`) });
    await validate(match);
    const menuSelector = `[data-muse-old="${match.marker}"] button[data-e2e-conversation-list-item-menu]`;
    const hoverDeadline = Date.now() + 3000;
    while (!await muse.page(({ selector }) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return element.getClientRects().length > 0;
    }, { selector: menuSelector })) {
      if (Date.now() >= hoverDeadline) {
        throw new Error(`Options button did not become visible after hovering over ${match.heading}.`);
      }
      await muse.wait(100);
    }
    const menuPoint = await pointFor(menuSelector);
    await muse.moveTo({ to: menuPoint });
    await validate(match);
    await muse.click(await pointFor(menuSelector));
    const archiveSelector = '[data-muse-old-archive="target"]';
    const menuDeadline = Date.now() + 15000;
    while (!await muse.page(() => {
      const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" &&
          !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
          [el.getAttribute("aria-label"), el.innerText].some(text =>
            /^(archive|archive conversation|archive this conversation)$/i.test((text || "").trim())));
      if (items.length > 1) throw new Error("Ambiguous Archive controls.");
      if (!items.length) return false;
      document.querySelectorAll("[data-muse-old-archive]").forEach(el => el.removeAttribute("data-muse-old-archive"));
      items[0].setAttribute("data-muse-old-archive", "target");
      return true;
    })) {
      if (Date.now() >= menuDeadline) throw new Error("Archive menu did not appear.");
      await muse.wait(300);
    }
    await muse.moveTo({ to: await pointFor(archiveSelector) });
    await validate(match);
    if (archived.length < 5) {
      await muse.confirm(`Archive "${match.heading}"?\nCard date: ${match.dates.join(" / ")}\nExplicitly unpinned. Confirmation ${archived.length + 1} of 5; automatic archiving afterward.\nMouse is over Archive. Y approves; N stops the script.`);
    }
    await validate(match);
    await muse.click(await pointFor(archiveSelector));
    const deadline = Date.now() + 15000;
    let absent = 0;
    while (absent < 2) {
      const removed = await muse.page(({ href, url }) => {
        if (location.href !== url) throw new Error("Page changed after Archive; outcome uncertain.");
        return ![...document.querySelectorAll("a[data-e2e-conversation]")]
          .some(link => link.getAttribute("href") === href) &&
          ![...document.querySelectorAll('[role="menu"]')].some(menu =>
            menu.getClientRects().length && getComputedStyle(menu).visibility !== "hidden");
      }, { href: match.href, url });
      absent = removed ? absent + 1 : 0;
      if (Date.now() >= deadline) throw new Error("Archive outcome uncertain; stopping without retry.");
      await muse.wait(500);
    }
    archived.push(match.href);
    if (archived.length === 5) await muse.log("Five confirmed archives completed; continuing automatically without further prompts.");
    await muse.log(`Confirmed archive: ${match.heading}. Total: ${archived.length}. Rescanning before scrolling.`);
    continue;
  }
  const scroll = await muse.page(() => {
    let element = document.querySelector("mws-conversation-list-item")?.parentElement;
    while (element) {
      if (/^(auto|scroll)$/.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight + 2) {
        const rect = element.getBoundingClientRect();
        const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
        const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
        if (top >= bottom || left >= right) throw new Error("List scroll area not visible.");
        element.setAttribute("data-muse-old-scroll", "target");
        return { before: element.scrollTop, height: bottom - top,
          scrollHeight: element.scrollHeight,
          rows: [...document.querySelectorAll("a[data-e2e-conversation]")]
            .map(link => link.getAttribute("href")),
          bottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
          point: { x: (left + right) / 2, y: (top + bottom) / 2 } };
      }
      element = element.parentElement;
    }
    throw new Error("Cannot establish scrollable list bounds; scan incomplete.");
  });
  if (scroll.bottom) {
    if (refreshedPass && archived.length === archivedAtRefresh) {
      await muse.log("Reached the list bottom after a page refresh with no new matching conversations; stopping.");
      break;
    }
    await muse.log(refreshedPass
      ? `Reached the list bottom; ${archived.length - archivedAtRefresh} archived since the last refresh. Refreshing the page and scanning again.`
      : "Reached the list bottom; refreshing the page and scanning again before stopping.");
    refreshedPass = true;
    archivedAtRefresh = archived.length;
    await loadList();
    await muse.log("Page refreshed; scanning from the top of the list.");
    continue;
  }
  await muse.moveTo({ to: scroll.point });
  const ticks = pixelsPerNotch === null ? 1 :
    Math.max(1, Math.min(6, Math.floor(scroll.height / 2 / pixelsPerNotch)));
  await muse.scroll(-ticks);
  await muse.wait(900);
  const after = await muse.page(() => {
    const element = document.querySelector('[data-muse-old-scroll="target"]');
    if (!element) throw new Error("Scroll area disappeared.");
    return element.scrollTop;
  });
  const distance = after - scroll.before;
  if (distance <= 0 || distance >= scroll.height * 0.8) {
    throw new Error("Wheel made no progress or jumped too far for safe overlap; scan incomplete.");
  }
  pixelsPerNotch = distance / ticks;
  await muse.log(`Native wheel (${ticks} notches): ${scroll.before} -> ${after}. Archived: ${archived.length}.`);
}
await muse.log(`Finished after a refreshed pass. Confirmed archived: ${archived.length}. Skipped: ${skipped.size}. Unclear dates were not archived.`);
return { archived: archived.length, skipped: skipped.size, rule: "three-letter month date or M/D/YY; explicitly unpinned" };
