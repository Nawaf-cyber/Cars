'use strict';
const express = require('express');
const A = require('../auth');
const P = require('../permissions');
const I = require('../integrations');

const router = express.Router();

/* =============================================================================
   شاشة ربط البرامج — لا يصل إليها إلا من يملك integrations.manage.
   الأسرار لا تغادر الخادم أبداً: تُحفظ، وتُقنَّع عند القراءة، وتُستعمل داخلياً.
   ============================================================================= */

router.get('/', P.needs('integrations.manage'), async (req, res) => {
  res.json({ definitions: I.definitions(), state: await I.state() });
});

router.put('/:name', P.needs('integrations.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    await I.save(req.params.name, b.values || {}, !!b.enabled);
    A.audit(req.user.id, 'تعديل ربط برنامج', 'integrations', null,
      { برنامج: req.params.name, مشغّل: !!b.enabled });     // بلا قيم — قد تحمل أسراراً
    res.json({ ok: true, state: await I.state() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:name/test', P.needs('integrations.manage'), async (req, res) => {
  try {
    const r = await I.test(req.params.name);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
