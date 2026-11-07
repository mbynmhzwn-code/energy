// ربات تلگرام ددلاین‌های مهندسی انرژی شریف
// Cloudflare Worker: webhook تلگرام + cron (هر دقیقه) برای یادآوری، اعلان رویدادها و اطلاعیه‌های دستی
//
// Secrets لازم: BOT_TOKEN, WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
// اختیاری: ADMIN_IDS (برای /stats)

// زمان پیش‌فرض یادآوری برای کسی که چیزی انتخاب نکرده؛ هر کاربر با /settings آن را عوض می‌کند
const DEFAULT_REMIND_HOURS = 6;
const REMIND_OPTIONS = [1, 3, 6, 12, 24, 48];
const MAX_REMIND_HOURS = 168; // حداکثر زمان دلخواه: ۷ روز
const LIST_LIMIT = 12;
// پلن رایگان کلودفلر در هر اجرا حداکثر ۵۰ درخواست خارجی اجازه می‌دهد؛
// پس هر دقیقه فقط به تعداد محدودی نفر پیام می‌دهیم و بقیه در اجرای بعدی می‌روند.
const SEND_BUDGET = 30;

const KINDS = {
  assignment: { emoji: '📝', name: 'تمرین/پروژه', when: 'مهلت تحویل', where: 'محل تحویل', remind: 'مهلت تحویل' },
  quiz: { emoji: '❓', name: 'کوییز', when: 'زمان کوییز', where: 'محل برگزاری', remind: 'کوییز' },
  exam: { emoji: '🎓', name: 'امتحان', when: 'زمان امتحان', where: 'محل برگزاری', remind: 'امتحان' },
};
const kindOf = row => KINDS[row.event_type] || KINDS.assignment;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env).catch(e => console.error('update error', e)));
      return new Response('ok');
    }
    return new Response('Deadline bot is running');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch(e => console.error('cron error', e)));
  },
};

/* ---------- helpers ---------- */

async function sb(env, path, init = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function tg(env, method, body, retry = true) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok && j.error_code === 429 && retry) {
    await new Promise(res => setTimeout(res, ((j.parameters && j.parameters.retry_after) || 2) * 1000));
    return tg(env, method, body, false);
  }
  return j;
}

const esc = s =>
  String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

const fmtDate = d =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);

const fmtTime = d =>
  new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

const fa = n => Number(n).toLocaleString('fa-IR');

// ۶ → «۶ ساعت»، ۲۴ → «۱ روز»، ۴۸ → «۲ روز»
const hoursLabel = h => (h >= 24 && h % 24 === 0 ? `${fa(h / 24)} روز` : `${fa(h)} ساعت`);

const toLatinDigits = s =>
  String(s)
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));

function remaining(due) {
  let m = Math.floor((due.getTime() - Date.now()) / 60000);
  if (m <= 0) return 'همین حالا';
  const d = Math.floor(m / 1440); m -= d * 1440;
  const h = Math.floor(m / 60); m -= h * 60;
  const parts = [];
  if (d) parts.push(`${fa(d)} روز`);
  if (h) parts.push(`${fa(h)} ساعت`);
  if (m && !d) parts.push(`${fa(m)} دقیقه`);
  return parts.join(' و ') + ' مانده';
}

// فایل‌های قابل ارسال یک رویداد (فقط از storage خود سوپابیس)
function filesOf(env, row) {
  const ok = u => typeof u === 'string' && u.startsWith(`${env.SUPABASE_URL}/storage/`);
  const out = [];
  if (ok(row.image_url)) {
    const ext = (row.image_url.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    out.push({ url: row.image_url, name: 'تصویر سؤال', fname: `question.${ext}`, kind: 'photo' });
  }
  for (const a of Array.isArray(row.attachments) ? row.attachments : []) {
    if (a && ok(a.url)) out.push({ url: a.url, name: a.name || 'فایل', fname: a.name || 'file', kind: 'doc' });
  }
  return out;
}

// فایل‌های یک اطلاعیهٔ دستی؛ عکس‌ها به‌صورت عکس و بقیه به‌صورت فایل فرستاده می‌شوند
function broadcastFiles(env, b) {
  const ok = u => typeof u === 'string' && u.startsWith(`${env.SUPABASE_URL}/storage/`);
  return (Array.isArray(b.attachments) ? b.attachments : [])
    .filter(a => a && ok(a.url))
    .map(a => {
      const isImg = /^image\/(jpeg|png|webp)$/i.test(a.type || '');
      return isImg
        ? { url: a.url, name: '', fname: a.name || 'photo.jpg', kind: 'photo' }
        : { url: a.url, name: a.name || 'فایل', fname: a.name || 'file', kind: 'doc' };
    });
}

function card(env, row) {
  const k = kindOf(row);
  const due = new Date(row.due_at);
  const L = [
    `${k.emoji} <b>${esc(row.title)}</b>`,
    `${k.name} · ${esc(row.course)}`,
    '',
    `🗓 ${k.when}: ${fmtDate(due)}، ساعت ${fmtTime(due)}`,
    `⏳ ${remaining(due)}`,
  ];
  if (row.submit_place) L.push(`📍 ${k.where}: ${esc(row.submit_place)}`);
  if (/^https?:\/\//i.test(row.submit_url || '')) L.push(`🔗 <a href="${esc(row.submit_url)}">لینک بارگذاری</a>`);
  const n = filesOf(env, row).length;
  if (n) L.push(`📎 ${fa(n)} فایل سؤال پیوست دارد`);
  if (row.description) L.push('', `💬 ${esc(row.description)}`);
  return L.join('\n');
}

// ارسال فایل به یک چت. فایل را خود Worker از سوپابیس می‌گیرد و به تلگرام می‌دهد،
// پس کاربر برای دریافت فایل به VPN نیاز ندارد.
async function sendMedia(env, chatId, f, cache) {
  let c = cache.get(f.url);
  if (!c) { c = {}; cache.set(f.url, c); }

  const attempt = async (method, field) => {
    if (c.file_id && c.method === method) {
      return tg(env, method, { chat_id: chatId, [field]: c.file_id, caption: f.name });
    }
    if (!c.blob) {
      const r = await fetch(f.url);
      if (!r.ok) return { ok: false, description: `fetch ${r.status}` };
      c.blob = await r.blob();
    }
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('caption', f.name);
    fd.append(field, c.blob, f.fname);
    const res = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', body: fd })).json();
    if (res.ok) {
      c.method = method;
      c.file_id = field === 'photo' ? res.result.photo[res.result.photo.length - 1].file_id : res.result.document.file_id;
    }
    return res;
  };

  let res = f.kind === 'photo' ? await attempt('sendPhoto', 'photo') : null;
  if (!res || !res.ok) res = await attempt('sendDocument', 'document');
  return res;
}

/* ---------- زمان یادآوریِ هر کاربر ---------- */

async function getSub(env, chatId) {
  const rows = await sb(env, `bot_subscribers?select=chat_id,remind_hours,awaiting_remind_until&chat_id=eq.${chatId}`);
  return rows && rows[0] ? rows[0] : null;
}

// ذخیرهٔ زمان یادآوری؛ اگر کاربر مشترک نباشد آرایهٔ خالی برمی‌گردد
async function setRemindHours(env, chatId, hours) {
  return sb(env, `bot_subscribers?chat_id=eq.${chatId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ remind_hours: hours, awaiting_remind_until: null }),
  });
}

async function askRemindTime(env, chatId, current, intro = '') {
  const rows = [];
  for (let i = 0; i < REMIND_OPTIONS.length; i += 3) {
    rows.push(
      REMIND_OPTIONS.slice(i, i + 3).map(h => ({
        text: (h === current ? '✅ ' : '') + hoursLabel(h),
        callback_data: `r:${h}`,
      }))
    );
  }
  rows.push([{ text: '✏️ زمان دلخواه', callback_data: 'r:custom' }]);
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `${intro}⏰ <b>چه مدت قبل از هر ددلاین، کوییز یا امتحان یادآوری بگیری؟</b>\n\nالان: ${hoursLabel(current)} قبل`,
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleRemindChoice(env, cq) {
  const chatId = cq.message.chat.id;
  const v = cq.data.slice(2);

  if (v === 'custom') {
    const rows = await sb(env, `bot_subscribers?chat_id=eq.${chatId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ awaiting_remind_until: new Date(Date.now() + 10 * 60e3).toISOString() }),
    });
    if (!rows || !rows.length) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'اول /start بزن.' });
      return;
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `تعداد ساعت را به‌صورت عدد بفرست (از ۱ تا ${fa(MAX_REMIND_HOURS)}).\nمثلاً «۱۸» یعنی ۱۸ ساعت قبل.`,
    });
    return;
  }

  const h = parseInt(v, 10);
  if (!REMIND_OPTIONS.includes(h)) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }
  const rows = await setRemindHours(env, chatId, h);
  if (!rows || !rows.length) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'اول /start بزن.' });
    return;
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'ذخیره شد ✅' });
  await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: `✅ از این به بعد ${hoursLabel(h)} قبل از هر ددلاین، کوییز یا امتحان برایت یادآوری می‌فرستم.\n\nبرای تغییر: /settings`,
  });
}

// اگر کاربر بعد از «زمان دلخواه» عدد فرستاده باشد، همین‌جا ثبتش می‌کنیم
async function handleFreeText(env, chatId, text) {
  const sub = await getSub(env, chatId);
  if (!sub || !sub.awaiting_remind_until || new Date(sub.awaiting_remind_until) < new Date()) return false;

  const m = toLatinDigits(text).match(/\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_REMIND_HOURS) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `یک عدد صحیح بین ۱ تا ${fa(MAX_REMIND_HOURS)} بفرست. مثلاً ۱۸`,
    });
    return true;
  }
  await setRemindHours(env, chatId, n);
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: `✅ از این به بعد ${hoursLabel(n)} قبل از هر ددلاین، کوییز یا امتحان برایت یادآوری می‌فرستم.\n\nبرای تغییر: /settings`,
  });
  return true;
}

/* ---------- commands ---------- */

const HELP = [
  '🤖 <b>ربات ددلاین‌های مهندسی انرژی شریف</b>',
  '',
  '/deadlines — همه موارد پیش‌رو',
  '/exams — امتحان‌ها',
  '/quizzes — کوییزها',
  '/assignments — تمرین‌ها و پروژه‌ها',
  '/settings — تنظیم زمان یادآوری',
  '/stop — قطع هشدارها',
  '',
  '⏰ قبل از هر ددلاین، کوییز یا امتحان، خودکار برایت یادآوری می‌فرستم و زمانش را خودت تعیین می‌کنی.',
].join('\n');

const LIST_TITLES = {
  exam: '🎓 امتحان‌های پیش‌رو',
  quiz: '❓ کوییزهای پیش‌رو',
  assignment: '📝 تمرین‌ها و پروژه‌های پیش‌رو',
  all: '📋 ددلاین‌های پیش‌رو',
};

async function listUpcoming(env, chatId, type) {
  const filter = type ? `&event_type=eq.${type}` : '';
  const rows = await sb(
    env,
    `deadlines?select=*&published=eq.true&due_at=gte.${new Date().toISOString()}${filter}&order=due_at.asc&limit=${LIST_LIMIT + 1}`
  );
  if (!rows.length) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'فعلاً موردی ثبت نشده است. 🎉' });
    return;
  }
  const shown = rows.slice(0, LIST_LIMIT);
  await tg(env, 'sendMessage', { chat_id: chatId, text: `<b>${LIST_TITLES[type || 'all']}</b>`, parse_mode: 'HTML' });
  for (const row of shown) {
    const n = filesOf(env, row).length;
    const msg = { chat_id: chatId, text: card(env, row), parse_mode: 'HTML', disable_web_page_preview: true };
    if (n) msg.reply_markup = { inline_keyboard: [[{ text: `📎 دریافت فایل‌های سؤال (${fa(n)})`, callback_data: `f:${row.id}` }]] };
    await tg(env, 'sendMessage', msg);
  }
  if (rows.length > LIST_LIMIT) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'موارد بیشتری هم هست. با /exams ، /quizzes یا /assignments لیست را دسته‌بندی کن.',
    });
  }
}

async function sendFilesForDeadline(env, chatId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  const rows = await sb(env, `deadlines?select=*&id=eq.${id}&published=eq.true`);
  if (!rows.length) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'این مورد دیگر موجود نیست.' });
    return;
  }
  const cache = new Map();
  const files = filesOf(env, rows[0]);
  if (!files.length) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'برای این مورد فایلی ثبت نشده.' });
    return;
  }
  for (const f of files) {
    const res = await sendMedia(env, chatId, f, cache);
    if (!res.ok) await tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ ارسال «${f.name}» انجام نشد. کمی بعد دوباره امتحان کن.` });
  }
}

async function handleUpdate(update, env) {
  const cq = update.callback_query;
  if (cq) {
    if (cq.data && cq.data.startsWith('r:') && cq.message) {
      await handleRemindChoice(env, cq);
      return;
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'در حال ارسال فایل‌ها…' });
    if (cq.data && cq.data.startsWith('f:') && cq.message) {
      await sendFilesForDeadline(env, cq.message.chat.id, cq.data.slice(2));
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // پیام معمولی (نه دستور): شاید عددِ «زمان دلخواه» باشد
  if (!text.startsWith('/') && (await handleFreeText(env, chatId, text))) return;

  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  switch (cmd) {
    case '/start': {
      await sb(env, 'bot_subscribers?on_conflict=chat_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          chat_id: chatId,
          first_name: msg.from?.first_name || '',
          username: msg.from?.username || '',
        }),
      });
      const sub = await getSub(env, chatId);
      await tg(env, 'sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: HELP + '\n\n✅ یادآوری‌ها برایت فعال شد.',
      });
      await askRemindTime(env, chatId, (sub && sub.remind_hours) || DEFAULT_REMIND_HOURS);
      break;
    }
    case '/settings':
    case '/remind': {
      const sub = await getSub(env, chatId);
      if (!sub) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'اول /start بزن تا یادآوری‌ها برایت فعال شود.' });
        break;
      }
      await askRemindTime(env, chatId, sub.remind_hours || DEFAULT_REMIND_HOURS);
      break;
    }
    case '/stop':
      await sb(env, `bot_subscribers?chat_id=eq.${chatId}`, { method: 'DELETE' });
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'یادآوری‌ها قطع شد. هر وقت خواستی دوباره /start بزن.' });
      break;
    case '/id':
      await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `شناسه چت شما: <code>${chatId}</code>` });
      break;
    case '/stats': await sendStats(env, chatId); break;
    case '/deadlines': await listUpcoming(env, chatId, null); break;
    case '/exams': await listUpcoming(env, chatId, 'exam'); break;
    case '/quizzes': await listUpcoming(env, chatId, 'quiz'); break;
    case '/assignments': await listUpcoming(env, chatId, 'assignment'); break;
    default:
      await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: HELP });
  }
}

/* ---------- reminders (cron) ---------- */

async function runCron(env) {
  const state = { budget: SEND_BUDGET };
  await sendReminders(env, state).catch(e => console.error('reminder error', e));
  await sendAnnouncements(env, state).catch(e => console.error('announcement error', e));
  await sendBroadcasts(env, state).catch(e => console.error('broadcast error', e));
}

async function sendReminders(env, state) {
  const subs = await sb(env, 'bot_subscribers?select=chat_id,remind_hours');
  if (!subs.length) return;

  const hoursOf = s => s.remind_hours || DEFAULT_REMIND_HOURS;
  const now = Date.now();
  // بازهٔ جست‌وجو را تا بلندترین زمان یادآوریِ بین کاربران باز می‌کنیم
  const maxHours = Math.max(...subs.map(hoursOf));
  const until = new Date(now + maxHours * 3600e3);

  const rows = await sb(
    env,
    `deadlines?select=*&published=eq.true&due_at=gt.${new Date(now).toISOString()}&due_at=lte.${until.toISOString()}&order=due_at.asc`
  );
  if (!rows.length) return;

  const done = await sb(
    env,
    `bot_deliveries?select=deadline_id,due_at,chat_id&deadline_id=in.(${rows.map(r => r.id).join(',')})`
  );
  const key = (id, due, chat) => `${id}|${new Date(due).getTime()}|${chat}`;
  const doneSet = new Set(done.map(x => key(x.deadline_id, x.due_at, x.chat_id)));

  // چه کسانی هنوز هشدار نگرفته‌اند؟ (در حد بودجهٔ این اجرا)
  let budget = state.budget;
  const pending = [];
  outer: for (const d of rows) {
    const dueMs = new Date(d.due_at).getTime();
    const cost = 1 + filesOf(env, d).length;
    for (const s of subs) {
      // هنوز وارد بازهٔ یادآوریِ این کاربر نشده‌ایم
      if (dueMs - now > hoursOf(s) * 3600e3) continue;
      if (doneSet.has(key(d.id, d.due_at, s.chat_id))) continue;
      if (budget < cost) break outer;
      budget -= cost;
      pending.push({ d, chat_id: s.chat_id, hours: hoursOf(s) });
    }
  }
  state.budget = budget;
  if (!pending.length) return;

  // ابتدا رزرو می‌کنیم تا اگر دو اجرا هم‌زمان شدند، پیام تکراری نرود
  const claimed = await sb(env, 'bot_deliveries?on_conflict=deadline_id,due_at,chat_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(pending.map(p => ({ deadline_id: p.d.id, due_at: p.d.due_at, chat_id: p.chat_id }))),
  });
  const claimedSet = new Set((claimed || []).map(x => key(x.deadline_id, x.due_at, x.chat_id)));

  const cache = new Map();
  for (const p of pending) {
    if (!claimedSet.has(key(p.d.id, p.d.due_at, p.chat_id))) continue;
    const k = kindOf(p.d);
    const text = `⏰ <b>یادآوری: کمتر از ${hoursLabel(p.hours)} تا ${k.remind} مانده!</b>\n\n${card(env, p.d)}`;
    const res = await tg(env, 'sendMessage', {
      chat_id: p.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });

    if (!res.ok) {
      if (res.error_code === 403 || res.error_code === 400) {
        // کاربر ربات را بلاک کرده یا چت حذف شده
        await sb(env, `bot_subscribers?chat_id=eq.${p.chat_id}`, { method: 'DELETE' }).catch(() => {});
      } else {
        // خطای موقت: رزرو را آزاد کن تا اجرای بعد دوباره تلاش کند
        await sb(
          env,
          `bot_deliveries?deadline_id=eq.${p.d.id}&due_at=eq.${encodeURIComponent(p.d.due_at)}&chat_id=eq.${p.chat_id}`,
          { method: 'DELETE' }
        ).catch(() => {});
      }
      continue;
    }
    for (const f of filesOf(env, p.d)) {
      await sendMedia(env, p.chat_id, f, cache).catch(() => {});
    }
  }
}

/* ---------- اعلان‌های دستی (تیک «ارسال اعلان» در پنل مدیر) ---------- */

async function sendAnnouncements(env, state) {
  if (state.budget < 1) return;
  const since = new Date(Date.now() - 2 * 86400e3).toISOString();
  const anns = await sb(env, `bot_announcements?select=*,deadlines(*)&created_at=gte.${since}&order=created_at.asc`);
  if (!anns.length) return;

  const subs = await sb(env, 'bot_subscribers?select=chat_id,created_at');
  if (!subs.length) return;

  const done = await sb(
    env,
    `bot_announcement_deliveries?select=announcement_id,chat_id&announcement_id=in.(${anns.map(a => a.id).join(',')})`
  );
  const doneSet = new Set(done.map(x => `${x.announcement_id}|${x.chat_id}`));

  const pending = [];
  outer: for (const a of anns) {
    if (!a.deadlines || !a.deadlines.published) continue;
    for (const s of subs) {
      if (new Date(s.created_at) > new Date(a.created_at)) continue; // کسی که بعد از اعلان عضو شده
      if (doneSet.has(`${a.id}|${s.chat_id}`)) continue;
      if (state.budget < 1) break outer;
      state.budget -= 1;
      pending.push({ a, chat_id: s.chat_id });
    }
  }
  if (!pending.length) return;

  const claimed = await sb(env, 'bot_announcement_deliveries?on_conflict=announcement_id,chat_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(pending.map(p => ({ announcement_id: p.a.id, chat_id: p.chat_id }))),
  });
  const claimedSet = new Set((claimed || []).map(x => `${x.announcement_id}|${x.chat_id}`));

  for (const p of pending) {
    if (!claimedSet.has(`${p.a.id}|${p.chat_id}`)) continue;
    const d = p.a.deadlines;
    const k = kindOf(d);
    const head = p.a.kind === 'update'
      ? `✏️ <b>${k.name} به‌روزرسانی شد</b>`
      : `🆕 <b>${k.name} جدید اضافه شد</b>`;
    const msg = {
      chat_id: p.chat_id, text: `${head}\n\n${card(env, d)}`,
      parse_mode: 'HTML', disable_web_page_preview: true,
    };
    const n = filesOf(env, d).length;
    if (n) msg.reply_markup = { inline_keyboard: [[{ text: `📎 دریافت فایل‌های سؤال (${fa(n)})`, callback_data: `f:${d.id}` }]] };

    const res = await tg(env, 'sendMessage', msg);
    if (!res.ok) {
      if (res.error_code === 403 || res.error_code === 400) {
        await sb(env, `bot_subscribers?chat_id=eq.${p.chat_id}`, { method: 'DELETE' }).catch(() => {});
      } else {
        await sb(env, `bot_announcement_deliveries?announcement_id=eq.${p.a.id}&chat_id=eq.${p.chat_id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }
}

/* ---------- اطلاعیهٔ آزاد (متن + عکس/فایل) از پنل مدیر ---------- */

async function sendBroadcasts(env, state) {
  if (state.budget < 1) return;
  const since = new Date(Date.now() - 2 * 86400e3).toISOString();
  const bcs = await sb(env, `bot_broadcasts?select=*&created_at=gte.${since}&order=created_at.asc`);
  if (!bcs.length) return;

  const subs = await sb(env, 'bot_subscribers?select=chat_id,created_at');
  if (!subs.length) return;

  const done = await sb(
    env,
    `bot_broadcast_deliveries?select=broadcast_id,chat_id&broadcast_id=in.(${bcs.map(b => b.id).join(',')})`
  );
  const doneSet = new Set(done.map(x => `${x.broadcast_id}|${x.chat_id}`));

  const pending = [];
  outer: for (const b of bcs) {
    const files = broadcastFiles(env, b);
    let first = true; // نفر اول فایل را از سوپابیس می‌گیرد و آپلود می‌کند
    for (const s of subs) {
      if (new Date(s.created_at) > new Date(b.created_at)) continue; // کسی که بعد از اطلاعیه عضو شده
      if (doneSet.has(`${b.id}|${s.chat_id}`)) continue;
      const cost = 1 + files.length + (first ? files.length : 0);
      if (state.budget < cost) break outer;
      state.budget -= cost;
      first = false;
      pending.push({ b, files, chat_id: s.chat_id });
    }
  }
  if (!pending.length) return;

  const claimed = await sb(env, 'bot_broadcast_deliveries?on_conflict=broadcast_id,chat_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(pending.map(p => ({ broadcast_id: p.b.id, chat_id: p.chat_id }))),
  });
  const claimedSet = new Set((claimed || []).map(x => `${x.broadcast_id}|${x.chat_id}`));

  const cache = new Map();
  for (const p of pending) {
    if (!claimedSet.has(`${p.b.id}|${p.chat_id}`)) continue;
    const head = p.b.title ? `📢 <b>${esc(p.b.title)}</b>` : '📢 <b>اطلاعیه</b>';
    const text = (p.b.body ? `${head}\n\n${esc(p.b.body)}` : head).slice(0, 4000);

    const res = await tg(env, 'sendMessage', {
      chat_id: p.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (!res.ok) {
      if (res.error_code === 403 || res.error_code === 400) {
        await sb(env, `bot_subscribers?chat_id=eq.${p.chat_id}`, { method: 'DELETE' }).catch(() => {});
      } else {
        await sb(env, `bot_broadcast_deliveries?broadcast_id=eq.${p.b.id}&chat_id=eq.${p.chat_id}`, { method: 'DELETE' }).catch(() => {});
      }
      continue;
    }
    for (const f of p.files) {
      await sendMedia(env, p.chat_id, f, cache).catch(() => {});
    }
  }
}

/* ---------- آمار (فقط مدیر) ---------- */

const isAdmin = (env, chatId) =>
  String(env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(chatId));

async function sendStats(env, chatId) {
  if (!isAdmin(env, chatId)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'این دستور فقط برای مدیر ربات است.' });
    return;
  }
  const subs = await sb(env, 'bot_subscribers?select=first_name,username,created_at,remind_hours&order=created_at.desc');
  const weekAgo = Date.now() - 7 * 86400e3;
  const lastWeek = subs.filter(s => new Date(s.created_at).getTime() >= weekAgo).length;
  const lines = subs.slice(0, 15).map((s, i) =>
    `${fa(i + 1)}. ${esc(s.first_name || 'بدون نام')}${s.username ? ' (@' + esc(s.username) + ')' : ''}`
  );

  // چند نفر چه زمانی برای یادآوری انتخاب کرده‌اند
  const byHours = {};
  for (const s of subs) {
    const h = s.remind_hours || DEFAULT_REMIND_HOURS;
    byHours[h] = (byHours[h] || 0) + 1;
  }
  const hoursLines = Object.keys(byHours)
    .map(Number)
    .sort((a, b) => a - b)
    .map(h => `${hoursLabel(h)} قبل: ${fa(byHours[h])} نفر`);

  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: [
      `👥 <b>مشترکین ربات: ${fa(subs.length)} نفر</b>`,
      `🆕 عضوهای ۷ روز اخیر: ${fa(lastWeek)} نفر`,
      '',
      '<b>زمان یادآوری انتخاب‌شده:</b>',
      ...(hoursLines.length ? hoursLines : ['—']),
      '',
      '<b>آخرین عضوها:</b>',
      ...(lines.length ? lines : ['هنوز کسی عضو نشده.']),
      '',
      'نکته: کسی که ربات را بلاک کند، فقط وقتی پیام بعدی به او ارسال شود از لیست حذف می‌شود.',
    ].join('\n'),
  });
}
