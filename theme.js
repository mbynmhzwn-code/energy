/* تم روشن/تیره: پیش‌فرض از تنظیم سیستم؛ انتخاب کاربر در localStorage ذخیره می‌شود */
(function () {
  var root = document.documentElement, KEY = 'energy-theme';
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  var t = saved();
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = t;
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('themeBtn');
    if (!b) return;
    function label() {
      var dark = root.dataset.theme === 'dark';
      b.textContent = dark ? 'حالت روشن' : 'حالت تیره';
      b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
    label();
    b.addEventListener('click', function () {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) {}
      label();
      document.dispatchEvent(new Event('themechange'));
    });
  });
})();
