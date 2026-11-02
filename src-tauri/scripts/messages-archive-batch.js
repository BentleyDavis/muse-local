// Async function body: muse and args are supplied by the automation runner.
//
// Batch-archives Google Messages conversations from an embedded address list.
// Run manually from the sidebar's "Local automation scripts" panel.
//
// Approach: scan the visible list HTML for ANY matching numbers, archive
// them via the row context menu (native mouse), then scan again without
// scrolling (archiving shifts the list, bringing new rows into view). Only
// when no matches are visible, scroll down one viewport. Stops at the bottom.
// Already-archived or contact-named conversations are skipped, never guessed.

const ADDRESSES = ["28777", "83992", "21525", "68953", "91994", "69877", "88170", "35433", "269679", "78309", "62715", "78378", "+18559441765", "48773", "51781", "22720", "22300", "332211", "74431", "87972", "+16823727211", "+18637661813", "+13214297604", "+17733940182", "+12147904139", "287898", "1410200582", "+14323489753", "+19086569508", "+16233992447", "+18317447469", "+15186458988", "+14155926683", "42689", "+14698092070", "55284", "65242", "+18556783268", "729725", "+19296068887", "+17605825221", "+12053952640", "1410200580", "1410200581", "+14079044224", "+13465171668", "+12149713082", "+12566335094", "+17084322498", "+13059024369", "+13862860375", "+13237946738", "+16469563986", "+14134721846", "41098", "+16507310705", "+12402583231", "1410200574", "247262", "+12147641091", "1410200575", "68494", "+12142955563", "+13134743798", "1410100062", "1410200576", "1410100063", "1410100064", "73529", "+16822004344", "1410200577", "1410200578", "1410100065", "1410100066", "1410100067", "+14059141682", "81906", "+18328102025", "+16108710294", "68559", "+16469216703", "+14077438816", "1410200568", "1410200569", "63090", "+13092370883", "1410100059", "1410200570", "1410200571", "1410100060", "1410200572", "1410200573", "+18337810506", "11112022", "1410100061", "+18457509828", "+14243912637", "+14697687335", "+17736767035", "+19177034527", "+14697684686", "+14697687603", "+12138100282", "+14708269851", "+16573948905", "+14707920424", "+16574088154", "+12133597494", "+19178269374", "+13322340611", "+13462210936", "+19178629564", "+17146869762", "+12133618457", "+16466597423", "+15625473586", "+19292707978", "+15625475787", "+19293185843", "+16462413963", "+16574685565", "+17148151690", "+14699083867", "+19156157997", "+16573844257", "+19293025783", "+14802087420", "+13464615473", "+16615161856", "+14244459376", "+18402069209", "+19728351224", "+16122317852", "+17188839483", "stich@gogostocks.net", "+16613434148", "+16615563292", "+13467746583", "+16613646760", "+16615161399", "+13462973652", "+16615252188", "amiya@webwalker.sbs", "+13475746279", "+16615160965", "+16466736557", "+14707211180", "+13472551830", "+13468168067", "+15303071408", "erma@rescuetee.shop", "+12133990187", "+14082216730", "+18056382874", "uemhfroj@gmail.com", "+19183933766", "dghwfsnh@gmail.com", "+14696972498", "+14696972798", "+16823571122", "+19402391471", "+19729713725", "yekesha@daddigital.co", "+19175876428", "molyett@iphoneedge.net", "+19073212345", "lavat@petblues.net", "lgqagf@winners.com", "+16823126795", "BIsIDjHfvzXOCTak@gmail.com", "qiwcNXcvlIOaaAxF@gmail.com", "aberrataaiv@outlook.com", "+12142278770", "+18444325614", "+12154025575", "1410200551", "+18444325613", "51095", "287287", "53744", "46782", "+18337151917", "+18442332941", "97636", "329674", "11113000", "1410200553", "1410100049", "1410200554", "1410100050", "70756", "+19207063782", "1410200555", "1410100051", "1410200556", "+526648297449", "1410200557", "1410200558", "1410100052", "1410100053", "1410200559", "1410200560", "1410100054", "1410200561", "1410200562", "1410200563", "1410100055", "1410100056", "1410200564", "1410100057", "1410200565", "+19492675368", "+19032685929", "1410100058", "1410200566", "+15123612841", "1410200567", "346637", "1410200547", "+14694982262", "+12136525943", "504504", "1410200548", "23045", "1410200549", "+16827080954", "97710", "53747", "+14154638762", "+14695157879", "1410200550", "+12134637184", "+12147180084", "+18178733448", "+19729141945", "1410100046", "72524", "1410100047", "+13193044356", "32522", "37443", "+12157954782", "+12257261281", "+14693183470", "+14697976519", "+19858526619", "+14696137864", "+14697976503", "+15049086319", "+14697976415", "+15176170614", "+14697976473", "+12257261382", "+14695124186", "+19852175830", "+13052159439", "+16316877106", "+19852175393", "+14402892980", "+17149263045", "+17148133502", "+17148133596", "+16316906104", "+16316906568", "+16316906442", "+17148835621", "+17145075469", "+17144005530", "+16316907064", "+16316906343", "+16313178135", "+16316906429", "+12145027765", "+12145072188", "+12145051997", "+16196736702", "+16196736612", "+16572965394", "+16196736638", "+16572962987", "+19292194944", "+13235280839", "+16198540985", "+16572965512", "+13235471051", "+15624760295", "+13235472680", "+19139536297", "+13108976241", "+13235476048", "+19099546429", "+14403130088", "+14692227571", "+19136450743", "+13474393698", "+16462560391", "+12016260547", "+17188394422", "+14692227571", "+13232295421", "+19256645537", "+19096961884", "+14803705421", "+14697142866", "+16469548623", "+14699332253", "1410100038", "1410200538", "1410200539", "34185", "+12144765286", "+19722364257", "1410100039", "1410200540", "1410200541", "87598", "+13464262457", "1410200542", "+18445272417", "1410100040", "+18443394719", "+16692543577", "1410100041", "+12142841400", "1410100042", "1410200543", "1410200544", "36397", "1410200545", "1410100043", "95686", "1410200546", "1410100044", "89407", "1410100045", "+17407458016", "+14694893515", "+19855134314", "+12146365895", "+12146935253", "+12147018587", "313131", "+12562245857", "+19857149429", "+14694829423", "+19723164468", "+16174069773", "+19858608890", "+19858606129", "+13322205352", "+19859911513", "+12256254567", "+19857148703", "+19856881495", "+14699897889", "+12252454364", "+19858605780", "+19859915092", "+15047297067", "+14692816331", "+14698300994", "+15127138610", "+14698609932", "+12163695539", "+12166065948", "+19852090946", "+19852267098", "+19852099780", "+19852174443", "+19852172960", "+19852174507", "+19852172871", "+19857902169", "+15045126581", "+19852175828", "+19852175578", "+15044397676", "+18033009869", "+12166661139", "+18032989732", "+13374101298", "+15042523704", "+12163276014", "+14692227571", "+14073352718", "+12166815691", "+17143102630", "+14077488667", "+18039184549", "+18036307629", "+15045126791", "+18036864048", "+16573253239", "+14693180774", "+14693181787", "+12142086046", "+17149069117", "+15172277402", "+14698419627", "+15045780205", "+14697975648", "+19857916437", "+14693443337", "+19852175845", "+19852174139", "+14693678890", "+19857916242", "+15048740845", "+12257268847", "+14697976413", "+15045086535", "+13312157161", "+18306245385", "+18555848315", "7726", "64900", "79290", "+19729396567", "80565", "+12149893470", "84706", "6838", "+19725884105", "+12702259022", "+13093269520", "+14016188781", "40123", "+16182264880", "+18334051488", "+14694161446", "+18147482562", "+18573860225", "+18174358143", "818818", "+18332044191", "+12082039516", "+15026638138", "+17262001216", "+16825165233", "22821", "73752", "71373", "467873", "23535", "22196", "226593", "61347", "+12163770844", "58028", "64574", "57199", "+18559283632", "+18177847707", "+18597192018", "76872", "70924", "87018", "56918", "+14806811908", "302489", "78774", "384636", "58419", "+14693820522", "+18062006973", "+18176184787", "+15122768740", "+12146091231", "+18333970246", "+18062143648", "+14695053320", "+13462786624", "+19454431852", "+15713970940", "+18179454606", "+14698208569", "+19405079035", "+18176185704", "+19452021538", "+18177531312", "+15128946531", "+15127788526", "+18777380280", "+17133476975", "+18176747110", "+18178038528", "+15128772551", "+12818497650", "+18322712792", "+16822075820"];

const digitsOf = (s) => (s.match(/\d/g) || []).join("");

function targetVariants(addr) {
  const d = digitsOf(addr);
  if (d.length === 11 && d[0] === "1") return [d, d.slice(1)];
  if (d.length === 10) return [d, "1" + d];
  return [d];
}

const targetToAddr = new Map();
for (const addr of ADDRESSES) {
  for (const v of targetVariants(addr)) {
    if (!targetToAddr.has(v)) targetToAddr.set(v, addr);
  }
}
const remaining = new Set(targetToAddr.keys());
const failCount = new Map();
await muse.log(`Batch archive: ${remaining.size} digit-patterns from ${ADDRESSES.length} addresses.`);

async function archiveOne(match, pageUrl) {
  // Open the row's context menu via native mouse.
  const menuTarget = await muse.page(({ selector }) => {
    const vis = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 &&
        style.visibility !== "hidden" && style.display !== "none";
    };
    const row = document.querySelector(selector);
    if (!row) throw new Error("Row disappeared.");
    const targets = [...row.querySelectorAll("span.mat-mdc-button-touch-target")]
      .filter((element) => {
        const button = element.closest('button, [role="button"]');
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        const labels = ["aria-label", "title", "mattooltip"].map((n) => button.getAttribute(n) || "");
        return vis(element) && (button.getAttribute("aria-haspopup") === "menu" ||
          labels.some((l) => /^(more options|more conversation options|conversation options|more actions)$/i.test(l.trim())));
      });
    if (targets.length !== 1) throw new Error("Could not uniquely identify the row's context-menu button.");
    const m = "muse-menu-" + Math.random().toString(36).slice(2);
    targets[0].setAttribute("data-muse-menu-target", m);
    return `${selector} [data-muse-menu-target="${m}"]`;
  }, { selector: match.selector });
  await muse.moveTo({ selector: menuTarget });
  await muse.click({ selector: menuTarget });

  // Click Archive in the menu.
  let archiveSel = null;
  const aDeadline = Date.now() + 15000;
  while (Date.now() < aDeadline && !archiveSel) {
    archiveSel = await muse.page(({ url }) => {
      if (location.href !== url) throw new Error("Page navigated unexpectedly.");
      const vis = (element) => {
        const style = getComputedStyle(element);
        return element.getClientRects().length > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      };
      const buttons = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .filter((el) => vis(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const labels = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"),
        el.getAttribute("mattooltip"), el.innerText].filter(Boolean).map((t) => t.trim());
      const found = buttons.filter((el) => labels(el).some((l) =>
        /^(archive|archive conversation|archive this conversation)$/i.test(l)));
      if (found.length > 1) throw new Error("Multiple Archive controls; refusing.");
      if (!found.length) return null;
      const m = "muse-arch-" + Math.random().toString(36).slice(2);
      found[0].setAttribute("data-muse-archive-target", m);
      return `[data-muse-archive-target="${m}"]`;
    }, { url: pageUrl });
    if (!archiveSel) await muse.wait(500);
  }
  if (!archiveSel) throw new Error("Archive menu item did not appear.");
  await muse.moveTo({ selector: archiveSel });
  await muse.click({ selector: archiveSel });
}

await muse.navigate("https://messages.google.com/web/conversations");
await muse.log("Waiting up to 60 seconds for Messages conversation list...");
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  const state = await muse.page(() => {
    const vis = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const loadingIndicator = [...document.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], mat-spinner, mat-progress-spinner, mat-progress-bar'
    )].some(vis);
    const conversations = [...document.querySelectorAll("mws-conversation-list-item")].filter(vis);
    return document.readyState !== "complete" || loadingIndicator
      ? "loading" : conversations.length ? "ready" : "waiting";
  });
  if (state === "ready") { ready = true; break; }
  await muse.wait(1000);
}
if (!ready) throw new Error("Messages conversation list did not load.");
// Start at the top (list is newest-first); no initial scroll.

let archived = 0;
const archivedAddrs = [];
const failed = [];
const t0 = Date.now();
const TIME_CAP = 90 * 60 * 1000;

async function progressSnapshot(reason) {
  await muse.log(`PROGRESS [${reason}]: ` + JSON.stringify({
    archivedCount: archived,
    remainingCount: remaining.size,
    failedCount: failed.length,
    archivedAddresses: archivedAddrs,
    remainingAddresses: [...remaining].map((d) => targetToAddr.get(d)),
    failedAddresses: failed,
  }));
}

while (remaining.size > 0 && Date.now() - t0 < TIME_CAP) {
  // Scan the visible HTML for ANY matching numbers.
  const matches = await muse.page((targets) => {
    const vis = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const found = [];
    for (const row of document.querySelectorAll("mws-conversation-list-item")) {
      if (!vis(row)) continue;
      const heading = (row.innerText || row.textContent || "").trim().split(/\r?\n/)[0].trim();
      const d = (heading.match(/\d/g) || []).join("");
      if (targets.includes(d)) {
        const marker = "muse-batch-" + Math.random().toString(36).slice(2);
        row.setAttribute("data-muse-batch-target", marker);
        found.push({ selector: `[data-muse-batch-target="${marker}"]`, digits: d, heading });
      }
    }
    return found;
  }, { targets: [...remaining] });

  if (matches.length > 0) {
    const pageUrl = await muse.page(() => location.href);
    for (const match of matches) {
      const addr = targetToAddr.get(match.digits);
      try {
        await archiveOne(match, pageUrl);
        archived++;
        archivedAddrs.push(addr);
        remaining.delete(match.digits);
        if (archived % 25 === 0) await progressSnapshot(`${archived} archived`);
      } catch (e) {
        const n = (failCount.get(match.digits) || 0) + 1;
        failCount.set(match.digits, n);
        if (n >= 3) {
          failed.push({ address: addr, heading: match.heading, error: String(e) });
          remaining.delete(match.digits);
          await muse.log(`GIVING UP ${addr} after 3 failures: ${String(e)}`);
        } else {
          await muse.log(`Retry ${addr} later (${n}/3): ${String(e)}`);
        }
      }
      await muse.page(({ selector }) => {
        document.querySelector(selector)?.removeAttribute("data-muse-batch-target");
      }, { selector: match.selector }).catch(() => {});
      await muse.wait(1200);
    }
    // Search again WITHOUT scrolling — archiving shifted new rows into view.
    continue;
  }

  // Nothing matching in view — scroll down one viewport.
  const pos = await muse.page(() => {
    const row = document.querySelector("mws-conversation-list-item");
    let el = row ? row.parentElement : null;
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 20) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + el.clientHeight);
        return { moved: el.scrollTop !== before };
      }
      el = el.parentElement;
    }
    return { moved: false };
  });
  if (!pos.moved) break; // bottom reached
  await muse.wait(900);
}

const leftover = [...remaining].map((d) => targetToAddr.get(d));
const summary = {
  archived,
  remainingCount: leftover.length,
  failedCount: failed.length,
  // Full lists for reference — copy from the Run output panel.
  notFoundAddresses: leftover,
  failedAddresses: failed,
};
await muse.log(`Done. Archived ${archived}. Not found: ${leftover.length}. Failed: ${failed.length}. Full lists are in the result above.`);
return summary;
