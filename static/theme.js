// Runs in <head> before the page paints: apply the saved theme (dark by default) so there is no flash.
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('tb.theme') === 'light' ? 'light' : 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
})();
