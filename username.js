const EXACT = ['it','mod','dev','bot','ceo','hod','sys','root','null','team','help','void'];
const PREFIX = ['admin','administrator','owner','moderator','staff','faculty','teacher','professor','principal','dean','official','support','system','security','zenith','anonymous','undefined','founder','developer','everyone','college'];
const LEET = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s' };

function checkUsername(raw) {
  const name = String(raw || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name))
    return { ok: false, error: 'Use 3-20 letters, numbers or _ only.' };
  const key = name.toLowerCase();                       // save this with a unique index
  const flat = key.replace(/[013457@$]/g, c => LEET[c]).replace(/_/g, '');
  const bad = EXACT.includes(flat) ||
    PREFIX.some(w => flat.startsWith(w) || flat.endsWith(w));
  if (bad) return { ok: false, error: 'That name is reserved. Pick another.' };
  return { ok: true, name, key };
}
module.exports = { checkUsername };
