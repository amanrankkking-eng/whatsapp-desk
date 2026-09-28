// A stand-in for Evolution API, for tests only. It answers the routes the desk calls and writes
// messages and receipts into the evolution_api tables exactly as Evolution 2.3 does, so the
// desk reads them through the same SQL it uses in production. Nothing here talks to WhatsApp.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

export async function startMockEvolution({ port, databaseUrl, apiKey }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  let clockOffset = 0;
  const nowMs = () => Date.now() + clockOffset;
  const people = new Map();          // phone -> { phone, lid, name }
  const groups = new Map();          // jid -> { jid, subject, members: [phone], admins: Set, announce }
  const sent = [];                   // every send the desk made through the API
  const chatSink = [];               // Google Chat posts redirected here in test mode
  let failNext = null;
  let receiptDelayMs = 150;

  const lidOf = phone => `${(BigInt(phone) * 7n + 13n).toString().slice(0, 15)}@lid`;
  const person = (phone, name) => {
    if (!people.has(phone)) people.set(phone, { phone, lid: lidOf(phone), name: name || null });
    if (name) people.get(phone).name = name;
    return people.get(phone);
  };
  // Like Evolution's cuid row ids: they grow with time, so same-second messages keep their order.
  let seq = 0;
  const rowId = () => 'c' + Date.now().toString(36) + String(++seq).padStart(6, '0') + crypto.randomBytes(4).toString('hex');
  const timers = new Set();
  const msgId = () => '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
  const instanceByName = async name => (await q(`select * from evolution_api."Instance" where name = $1`, [name]))[0];
  const phoneOfInstance = i => (i?.ownerJid ? i.ownerJid.split('@')[0] : null);
  const membersOf = jid => groups.get(jid)?.members || [];

  // Store one message the way Evolution does, for every one of our instances that is in the chat.
  // A direct chat is stored by the number it was sent to (toPhone) and the number that sent it.
  async function storeMessage({ jid, fromPhone, toPhone, text, media, quotedId }) {
    const ts = Math.floor(nowMs() / 1000);
    const id = msgId();
    const sender = person(fromPhone);
    const insts = await q(`select * from evolution_api."Instance" where "connectionStatus" = 'open'`);
    const g = groups.get(jid);
    const message = media ? { imageMessage: { caption: text || '', mimetype: media.mimetype, fileLength: 1200 } } : { conversation: text };
    const type = media ? 'imageMessage' : 'conversation';
    const context = quotedId ? { stanzaId: quotedId, quotedMessage: { conversation: 'quoted' } } : null;
    let senderRow = null;
    for (const inst of insts) {
      const phone = phoneOfInstance(inst);
      const inChat = g ? g.members.includes(phone) : (phone === fromPhone || phone === toPhone);
      if (!inChat) continue;
      const fromMe = phone === fromPhone;
      const key = { id, fromMe, remoteJid: jid, ...(g ? { participant: sender.lid, addressingMode: 'lid' } : {}),
        ...(g && !fromMe ? { participantAlt: `${fromPhone}@s.whatsapp.net` } : {}) };
      const rid = rowId();
      await q(`insert into evolution_api."Message" (id, key, "pushName", "messageType", message, "contextInfo", source, "messageTimestamp", "instanceId", status)
        values ($1,$2,$3,$4,$5,$6,'android',$7,$8,$9)`,
        [rid, key, sender.name || fromPhone, type, message, context, ts, inst.id, fromMe ? 'PENDING' : 'DELIVERY_ACK']);
      await q(`insert into evolution_api."Chat" (id, "remoteJid", "instanceId", "unreadMessages", "updatedAt") values ($1,$2,$3,$4,now())
        on conflict ("instanceId", "remoteJid") do update set "unreadMessages" = "Chat"."unreadMessages" + $4, "updatedAt" = now()`,
        [rowId(), jid, inst.id, fromMe ? 0 : 1]);
      if (g) await q(`insert into evolution_api."Contact" (id, "remoteJid", "pushName", "instanceId") values ($1,$2,$3,$4)
        on conflict ("remoteJid", "instanceId") do update set "pushName" = excluded."pushName"`, [rowId(), jid, g.subject, inst.id]);
      if (fromMe) senderRow = { rid, inst };
    }
    return { id, ts, senderRow, message, type };
  }

  // Receipts arrive a moment later: server ack, then delivered and read, one row per member.
  function scheduleReceipts(jid, id, senderRow, fromPhone) {
    if (!senderRow) return;
    const t = setTimeout(async () => {
      timers.delete(t);
      try {
        const up = (participant, status) => q(`insert into evolution_api."MessageUpdate" (id, "keyId", "remoteJid", "fromMe", participant, status, "messageId", "instanceId")
          values ($1,$2,$3,true,$4,$5,$6,$7)`, [rowId(), id, jid, participant, status, senderRow.rid, senderRow.inst.id]);
        await up(null, 'SERVER_ACK');
        const others = groups.has(jid) ? membersOf(jid).filter(p => p !== fromPhone) : [jid.split('@')[0]];
        for (const p of others) await up(groups.has(jid) ? person(p).lid : null, 'DELIVERY_ACK');
        for (const p of others) await up(groups.has(jid) ? person(p).lid : null, 'READ');
      } catch (e) { console.error('[mock receipts]', e.message); }
    }, receiptDelayMs);
    timers.add(t);
  }

  const groupJson = jid => {
    const g = groups.get(jid);
    return { id: jid, subject: g.subject, subjectOwner: null, size: g.members.length, creation: 1700000000, owner: null, desc: null,
      restrict: false, announce: !!g.announce, isCommunity: false, isCommunityAnnounce: false,
      participants: g.members.map(p => ({ id: person(p).lid, phoneNumber: `${p}@s.whatsapp.net`, admin: g.admins?.has(p) ? 'admin' : null })) };
  };

  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const notFound = (res, name) => json(res, 404, { status: 404, error: 'Not Found', response: { message: [`The "${name}" instance does not exist`] } });
  const qr = () => ({ pairingCode: null, code: '2@mock', base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', count: 1 });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let body = {};
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      // ------------------------------------------------ test controls
      if (p === '/chat-sink' && req.method === 'POST') { chatSink.push({ to: url.searchParams.get('to'), text: body.text, at: new Date(nowMs()).toISOString() }); return json(res, 200, {}); }
      if (p.startsWith('/mock/')) {
        const cmd = p.slice(6);
        if (cmd === 'clock') { clockOffset = new Date(body.iso).getTime() - Date.now(); return json(res, 200, { now: new Date(nowMs()).toISOString() }); }
        if (cmd === 'person') { person(body.phone, body.name); return json(res, 200, people.get(body.phone)); }
        if (cmd === 'link') {
          const i = await instanceByName(body.instance);
          if (!i) return notFound(res, body.instance);
          person(body.phone, body.name);
          await q(`update evolution_api."Instance" set "connectionStatus" = 'open', "ownerJid" = $2, "profileName" = $3 where id = $1`, [i.id, `${body.phone}@s.whatsapp.net`, body.name]);
          return json(res, 200, { ok: true });
        }
        if (cmd === 'state') { await q(`update evolution_api."Instance" set "connectionStatus" = $2 where name = $1`, [body.instance, body.state]); return json(res, 200, { ok: true }); }
        if (cmd === 'group') {
          for (const m of body.members) person(m);
          groups.set(body.jid, { jid: body.jid, subject: body.subject, members: [...body.members], admins: new Set(body.admins || []), announce: !!body.announce });
          // Evolution learns about a group from its chat list; store an empty chat row per member instance.
          for (const i of await q(`select * from evolution_api."Instance" where "connectionStatus" = 'open'`)) {
            if (!body.members.includes(phoneOfInstance(i))) continue;
            await q(`insert into evolution_api."Chat" (id, "remoteJid", "instanceId", "updatedAt") values ($1,$2,$3,now()) on conflict do nothing`, [rowId(), body.jid, i.id]);
          }
          return json(res, 200, groupJson(body.jid));
        }
        if (cmd === 'group/add') { const g = groups.get(body.jid); person(body.phone); if (!g.members.includes(body.phone)) g.members.push(body.phone); return json(res, 200, groupJson(body.jid)); }
        if (cmd === 'group/remove') { const g = groups.get(body.jid); g.members = g.members.filter(x => x !== body.phone); return json(res, 200, groupJson(body.jid)); }
        if (cmd === 'message') {
          const r = await storeMessage({ jid: body.jid, fromPhone: body.from, toPhone: body.to, text: body.text });
          scheduleReceipts(body.jid, r.id, r.senderRow, body.from);
          return json(res, 200, { id: r.id, ts: r.ts });
        }
        if (cmd === 'fail-next') { failNext = body; return json(res, 200, { ok: true }); }
        if (cmd === 'receipt-delay') { receiptDelayMs = Number(body.ms) || 0; return json(res, 200, { ok: true }); }
        if (cmd === 'sent') return json(res, 200, sent);
        if (cmd === 'chat-sink') { if (req.method === 'DELETE') chatSink.length = 0; return json(res, 200, chatSink); }
        return json(res, 404, { error: 'unknown mock command' });
      }

      // ------------------------------------------------ the Evolution API surface
      if (req.headers.apikey !== apiKey) return json(res, 401, { status: 401, error: 'Unauthorized' });
      let m;
      if (p === '/instance/fetchInstances') {
        const list = await q(`select * from evolution_api."Instance" order by "createdAt"`);
        return json(res, 200, list.map(i => ({ id: i.id, name: i.name, connectionStatus: i.connectionStatus, ownerJid: i.ownerJid, profileName: i.profileName, integration: i.integration })));
      }
      if ((m = p.match(/^\/instance\/connectionState\/(.+)$/))) {
        const i = await instanceByName(decodeURIComponent(m[1]));
        if (!i) return notFound(res, m[1]);
        return json(res, 200, { instance: { instanceName: i.name, state: i.connectionStatus } });
      }
      if (p === '/instance/create' && req.method === 'POST') {
        if (await instanceByName(body.instanceName)) return json(res, 403, { status: 403, error: 'Forbidden', response: { message: [`This name "${body.instanceName}" is already in use.`] } });
        const id = crypto.randomUUID();
        await q(`insert into evolution_api."Instance" (id, name, "connectionStatus", integration) values ($1,$2,'connecting','WHATSAPP-BAILEYS')`, [id, body.instanceName]);
        const code = qr();
        if (body.number) code.pairingCode = 'WZYX1234';
        return json(res, 201, { instance: { instanceName: body.instanceName, instanceId: id, status: 'connecting' }, hash: 'x', settings: body, qrcode: code });
      }
      if ((m = p.match(/^\/instance\/connect\/(.+)$/))) {
        const i = await instanceByName(decodeURIComponent(m[1]));
        if (!i) return notFound(res, m[1]);
        if (i.connectionStatus === 'open') return json(res, 200, { instance: { instanceName: i.name, state: 'open' } });
        if (i.connectionStatus === 'close') await q(`update evolution_api."Instance" set "connectionStatus" = 'connecting' where id = $1`, [i.id]);
        const code = qr();
        if (url.searchParams.get('number') && i.connectionStatus === 'close') code.pairingCode = 'WZYX1234';
        return json(res, 200, code);
      }
      if ((m = p.match(/^\/instance\/logout\/(.+)$/))) {
        const i = await instanceByName(decodeURIComponent(m[1]));
        if (!i) return notFound(res, m[1]);
        if (i.connectionStatus === 'close') return json(res, 400, { status: 400, error: 'Bad Request', response: { message: [`The "${i.name}" instance is not connected`] } });
        await q(`update evolution_api."Instance" set "connectionStatus" = 'close' where id = $1`, [i.id]);
        return json(res, 200, { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
      }
      if ((m = p.match(/^\/instance\/delete\/(.+)$/))) {
        const i = await instanceByName(decodeURIComponent(m[1]));
        if (!i) return notFound(res, m[1]);
        await q(`delete from evolution_api."Instance" where id = $1`, [i.id]);
        return json(res, 200, { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } });
      }
      // Everything below needs a connected number.
      const im = p.match(/^\/(?:group|message|chat)\/[A-Za-z0-9]+\/(.+)$/);
      const inst = im ? await instanceByName(decodeURIComponent(im[1])) : null;
      if (im && !inst) return notFound(res, im[1]);
      if (inst && inst.connectionStatus !== 'open') return json(res, 400, { status: 400, error: 'Bad Request', response: { message: ['Connection Closed'] } });
      const myPhone = phoneOfInstance(inst);
      if (p.startsWith('/group/fetchAllGroups/')) {
        return json(res, 200, [...groups.keys()].filter(j => groups.get(j).members.includes(myPhone)).map(groupJson));
      }
      if (p.startsWith('/group/findGroupInfos/')) {
        const jid = url.searchParams.get('groupJid');
        if (!groups.has(jid) || !groups.get(jid).members.includes(myPhone)) return json(res, 400, { error: 'item-not-found' });
        return json(res, 200, groupJson(jid));
      }
      if (p.startsWith('/message/sendText/') || p.startsWith('/message/sendMedia/')) {
        if (failNext) { const f = failNext; failNext = null; return json(res, f.status || 500, { status: f.status || 500, error: 'Internal Server Error', response: { message: [f.message || 'mock failure'] } }); }
        const jid = body.number;
        if (groups.has(jid) && !groups.get(jid).members.includes(myPhone)) return json(res, 400, { status: 400, response: { message: ['not a participant'] } });
        const media = p.startsWith('/message/sendMedia/') ? { mimetype: body.mimetype } : null;
        const text = media ? body.caption : body.text;
        const r = await storeMessage({ jid, fromPhone: myPhone, text, media, quotedId: body.quoted?.key?.id });
        sent.push({ instance: inst.name, jid, text, mentioned: body.mentioned || [], media: !!media, id: r.id, at: new Date(nowMs()).toISOString() });
        scheduleReceipts(jid, r.id, r.senderRow, myPhone);
        return json(res, 201, { key: { remoteJid: jid, fromMe: true, id: r.id }, pushName: inst.profileName, status: 'PENDING', message: r.message, messageType: r.type, messageTimestamp: r.ts });
      }
      if (p.startsWith('/chat/getBase64FromMediaMessage/')) {
        return json(res, 200, { mediaType: 'imageMessage', fileName: 'image.png', mimetype: 'image/png', base64: qr().base64.split(',')[1] });
      }
      return json(res, 404, { error: `mock has no route ${req.method} ${p}` });
    } catch (e) {
      console.error('[mock]', e);
      return json(res, 500, { error: e.message });
    }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: async () => { for (const t of timers) clearTimeout(t); server.close(); await pool.end(); }, people, groups, sent, chatSink, lidOf };
}
