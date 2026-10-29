import "./style.css";
import { escapeHTML as esc } from "../shared/text.ts";
import { api, ApiError } from "./api.ts";
import { mountAgent } from "./views/agent.ts";
import { mountBill } from "./views/bill-detail.ts";
import { mountBills, mountNewBill } from "./views/bills.ts";
import { mountHome } from "./views/home.ts";
import { mountInvoice } from "./views/invoice-detail.ts";
import { mountInvoices } from "./views/invoices.ts";
import { mountPay } from "./views/pay.ts";
import { mountPayroll } from "./views/payroll.ts";
import { mountPayrollBatch } from "./views/payroll-batch.ts";
import { mountLogin } from "./views/login.ts";
import { mountSwap } from "./views/swap.ts";
import { mountWithdraw } from "./views/withdraw.ts";
import { disconnectWallet, type Session } from "./wallet/index.ts";

export type Mount = (el: HTMLElement, params: Record<string, string>) => () => void;

type Route = { name: string; params: Record<string, string>; public: boolean; nav: string; title: string };

const views = new Map<string, Mount>();
export function registerView(name: string, mount: Mount): void {
  views.set(name, mount);
}

const ROUTES: { pattern: RegExp; name: string; keys: string[]; public?: boolean; nav: string; title: string }[] = [
  { pattern: /^\/?$/, name: "home", keys: [], nav: "home", title: "Home" },
  { pattern: /^\/invoices\/?$/, name: "invoices", keys: [], nav: "invoices", title: "Invoices" },
  { pattern: /^\/invoices\/([^/]+)\/?$/, name: "invoice", keys: ["id"], nav: "invoices", title: "Invoice" },
  { pattern: /^\/bills\/?$/, name: "bills", keys: [], nav: "bills", title: "Bills" },
  { pattern: /^\/bills\/new\/?$/, name: "bill-new", keys: [], nav: "bills", title: "New bill" },
  { pattern: /^\/bills\/([^/]+)\/?$/, name: "bill", keys: ["id"], nav: "bills", title: "Bill" },
  { pattern: /^\/payroll\/?$/, name: "payroll", keys: [], nav: "payroll", title: "Payroll" },
  { pattern: /^\/payroll\/([^/]+)\/?$/, name: "payroll-batch", keys: ["id"], nav: "payroll", title: "Payout" },
  { pattern: /^\/swap\/?$/, name: "swap", keys: [], nav: "swap", title: "Swap" },
  { pattern: /^\/withdraw\/?$/, name: "withdraw", keys: [], nav: "withdraw", title: "Withdraw" },
  { pattern: /^\/agent\/?$/, name: "agent", keys: [], nav: "agent", title: "Agent" },
  { pattern: /^\/pay\/([^/]+)\/?$/, name: "pay", keys: ["publicId"], public: true, nav: "", title: "Pay invoice" },
];

export function parseRoute(hash: string): Route | null {
  const path = hash.replace(/^#/, "") || "/";
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { name: r.name, params, public: !!r.public, nav: r.nav, title: r.title };
  }
  return null;
}

registerView("home", mountHome);
registerView("invoices", mountInvoices);
registerView("invoice", mountInvoice);
registerView("bills", mountBills);
registerView("bill-new", mountNewBill);
registerView("bill", mountBill);
registerView("payroll", mountPayroll);
registerView("payroll-batch", mountPayrollBatch);
registerView("swap", mountSwap);
registerView("withdraw", mountWithdraw);
registerView("agent", mountAgent);
registerView("pay", mountPay);

// Desktop sidebar lists every entry. The mobile bottom bar shows the primary ones plus "More",
// which opens the rest (Payroll, Withdraw, Agent) and Sign out.
const NAV: [string, string, string, string][] = [
  ["home", "#/", "◫", "Home"],
  ["invoices", "#/invoices", "▤", "Invoices"],
  ["bills", "#/bills", "▥", "Bills"],
  ["swap", "#/swap", "⇄", "Swap"],
  ["payroll", "#/payroll", "☰", "Payroll"],
  ["withdraw", "#/withdraw", "↗", "Withdraw"],
  ["agent", "#/agent", "✦", "Agent"],
];
const MOBILE_PRIMARY = new Set(["home", "invoices", "bills", "swap"]);

const app = document.querySelector<HTMLDivElement>("#app")!;
let session: Session | null | undefined; // undefined = not yet known
let sessionError = "";
let unmount: () => void = () => {};

function shortAccount(a: string): string {
  if (/^0x[0-9a-f]{40}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

const brand = `<a class="brand" href="#/" aria-label="Manexus home"><span class="brandmark">m</span>manexus<span class="dot">.</span></a>`;
const footer = `<footer><span>Non-custodial: Manexus never holds your keys or funds.</span><span>Powered by NEAR Intents</span></footer>`;

const current = (route: Route, id: string) => (route.nav === id ? ' aria-current="page"' : "");

function navHtml(route: Route): string {
  const links = NAV.map(
    ([id, href, icon, label]) =>
      `<a href="${href}" class="nav ${route.nav === id ? "active" : ""} ${MOBILE_PRIMARY.has(id) ? "" : "nav-secondary"}"${current(route, id)}><span aria-hidden="true">${icon}</span>${esc(label)}</a>`,
  ).join("");
  const rest = NAV.filter(([id]) => !MOBILE_PRIMARY.has(id));
  const moreActive = rest.some(([id]) => route.nav === id);
  const menu = `${rest
    .map(([id, href, icon, label]) => `<a href="${href}" class="more-item ${route.nav === id ? "active" : ""}"${current(route, id)}><span aria-hidden="true">${icon}</span>${esc(label)}</a>`)
    .join("")}<button type="button" class="more-item" id="more-sign-out"><span aria-hidden="true">⏻</span>Sign out</button>`;
  return `${links}<button type="button" class="nav nav-more ${moreActive ? "active" : ""}" id="nav-more" aria-haspopup="true" aria-expanded="false" aria-controls="more-menu"><span aria-hidden="true">⋯</span>More</button><div class="more-menu" id="more-menu" hidden>${menu}</div>`;
}

function wireMore(): void {
  const btn = app.querySelector<HTMLButtonElement>("#nav-more")!;
  const menu = app.querySelector<HTMLElement>("#more-menu")!;
  const set = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    set(menu.hidden);
  };
  menu.onclick = (e) => {
    if ((e.target as HTMLElement).closest("a")) set(false);
  };
  app.querySelector<HTMLButtonElement>("#more-sign-out")!.onclick = () => {
    set(false);
    void signOut();
  };
  app.onkeydown = (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      set(false);
      btn.focus();
    }
  };
  app.onclick = (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest("#more-menu, #nav-more")) set(false);
  };
}

function shell(route: Route, s: Session): HTMLElement {
  app.className = "";
  app.innerHTML = `<aside>${brand}<span class="workspace">YOUR BUSINESS</span><nav aria-label="Main navigation">${navHtml(route)}</nav><div class="sidebottom"><div class="network"><i></i> Powered by NEAR Intents</div><p>Manexus · v0.1</p></div></aside><div class="page"><header><span class="crumb">Workspace <span>/</span> ${esc(route.title)}</span><div class="header-right"><span class="account-chip" title="${esc(s.account)}"><span class="kind">${s.kind === "near" ? "NEAR" : "EVM"}</span><span class="account-id">${esc(shortAccount(s.account))}</span></span><button class="textbutton" id="sign-out">Sign out</button></div></header><main id="content"></main>${footer}</div>`;
  app.querySelector<HTMLButtonElement>("#sign-out")!.onclick = signOut;
  wireMore();
  return app.querySelector<HTMLElement>("#content")!;
}

function bare(title: string): HTMLElement {
  app.className = "bare";
  app.onclick = null;
  app.onkeydown = null;
  app.innerHTML = `<div class="page"><header>${brand}<span class="crumb">${esc(title)}</span></header><main id="content"></main>${footer}</div>`;
  return app.querySelector<HTMLElement>("#content")!;
}

function render(): void {
  unmount();
  unmount = () => {};
  const route = parseRoute(location.hash);
  if (!route) {
    const el = session ? shell({ name: "", params: {}, public: false, nav: "", title: "Not found" }, session) : bare("Not found");
    el.innerHTML = `<div class="heading"><div><h1>Page not found</h1><p class="muted"><a href="#/">Go to home</a></p></div></div>`;
    return;
  }
  if (route.public) {
    unmount = views.get(route.name)!(bare(route.title), route.params);
    return;
  }
  if (session === undefined) {
    bare("Loading").innerHTML = `<p class="muted" role="status">Loading…</p>`;
    return;
  }
  if (session === null) {
    unmount = mountLogin(
      bare("Sign in"),
      (s) => {
        session = s;
        sessionError = "";
        render();
      },
      sessionError,
    );
    return;
  }
  unmount = views.get(route.name)!(shell(route, session), route.params);
}

async function signOut(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* cookie may already be gone */
  }
  await disconnectWallet();
  session = null;
  render();
}

async function loadSession(): Promise<void> {
  try {
    session = await api<Session>("/api/me");
  } catch (e) {
    session = null;
    if (!(e instanceof ApiError && e.status === 401)) sessionError = "Could not reach the server. Try again in a moment.";
  }
  render();
}

window.addEventListener("hashchange", render);
render();
void loadSession();
