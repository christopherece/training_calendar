/* Light or dark mode. Follows the device until someone uses the toggle; the choice is then remembered on this device.
   Loaded in <head> so the page never flashes the wrong colours. */
(function () {
  var root = document.documentElement, KEY = 'westhaven-theme';
  var system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() {
    var s = stored();
    return s === 'dark' || s === 'light' ? s : system && system.matches ? 'dark' : 'light';
  }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0B0C2A' : '#FFFFFF');
    var b = document.getElementById('theme-toggle');
    if (b) {
      b.setAttribute('aria-pressed', String(t === 'dark'));
      b.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  apply(current());
  document.addEventListener('DOMContentLoaded', function () {
    apply(current());
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var t = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, t); } catch (e) { /* still switches for this visit */ }
      apply(t);
    });
    if (system) system.addEventListener('change', function () { if (!stored()) apply(current()); });
  });
})();
