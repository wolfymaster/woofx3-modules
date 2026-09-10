// Sibling-relative load proves the frame's <base href> resolves through
// barkloader's asset route rather than the page origin.
window.addEventListener("message", (e) => {
  const el = document.getElementById("v");
  if (el && e.data && e.data.type) el.textContent = String(e.data.type);
});
