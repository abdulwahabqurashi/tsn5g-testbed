/**
 * Hyperscript. Deliberately has no innerHTML escape hatch.
 *
 * The old helper accepted an `html:` attribute, and icons.js returned SVG as a
 * string. That is fine while every input is a literal, and an XSS foot-gun the
 * moment a backend string reaches it — SSIDs, operator names, error text and
 * switch CLI output all end up on screen. Everything here goes through
 * createElement and textContent, and scripts/lint-js.sh fails the build if
 * innerHTML appears anywhere under web/js/.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function applyProps(node, props, ns) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;

    if (k === "class" || k === "className") {
      if (ns) node.setAttribute("class", v);
      else node.className = v;
    } else if (k === "style" && typeof v === "object") {
      for (const [prop, val] of Object.entries(v)) {
        if (val !== null && val !== undefined) node.style.setProperty(prop, String(val));
      }
    } else if (k === "dataset" && typeof v === "object") {
      for (const [d, val] of Object.entries(v)) node.dataset[d] = String(val);
    } else if (k === "text") {
      node.textContent = String(v);
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
}

function appendKids(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/** h("div", {class: "card"}, "text", childNode, [more, nodes]) */
export function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  applyProps(node, props, false);
  appendKids(node, kids);
  return node;
}

/** Same, in the SVG namespace. Charts and icons build real SVG nodes. */
export function svg(tag, props, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props, true);
  appendKids(node, kids);
  return node;
}

export function frag(...kids) {
  const f = document.createDocumentFragment();
  appendKids(f, kids);
  return f;
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's contents in one step. */
export function fill(node, ...kids) {
  clear(node);
  appendKids(node, kids);
  return node;
}

/** addEventListener that returns its own disposer, for view cleanup. */
export function on(node, type, fn, opts) {
  node.addEventListener(type, fn, opts);
  return () => node.removeEventListener(type, fn, opts);
}

/** Scroll-safe: true when the element is within `slack` px of its bottom. */
export function atBottom(node, slack = 40) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= slack;
}
