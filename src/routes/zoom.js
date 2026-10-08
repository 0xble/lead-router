/**
 * zoom.js — Zoom webhook handler
 *
 * POST /zoom-webhook
 *   1. Receives recording.transcript_completed event from Zoom
 *   2. Downloads the VTT transcript
 *   3. Sends transcript to OpenAI to extract structured fields
 *   4. Updates the matching Airtable Appointments record
 *
 * Extraction logic (prompt, field mapping, lead score) lives in:
 *   src/jobs/transcriptProcessor.js
 */

const express = require('express');
const router  = express.Router();

const { extractFields, buildAirtableFields } = require('../jobs/transcriptProcessor');

const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE   = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE  = 'Appointments';

// ── Download the VTT transcript from Zoom ────────────────────────────────────
async function downloadTranscript(downloadUrl, downloadToken) {
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${downloadToken}` },
  });
  if (!res.ok) throw new Error(`Transcript download failed: ${res.status}`);
  return res.text();
}

// ── Find Airtable record by Zoom Meeting ID ───────────────────────────────────
async function findAppointmentRecord(meetingId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${encodeURIComponent(`{Zoom Meeting ID} = "${meetingId}"`)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Airtable lookup failed: ${res.status}`);
  const data = await res.json();
  return data.records?.[0] ?? null;
}

// ── Update Airtable record ────────────────────────────────────────────────────
async function updateAirtableRecord(recordId, fields, needsManualReview = false, shareUrl = null) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    },
    body: JSON.stringify({
      fields: buildAirtableFields(fields, {
        'Needs Manual Review?': needsManualReview,
        'Call Transcript URL':  shareUrl,
      }),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable update failed: ${res.status} — ${err}`);
  }
  return res.json();
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────
function createZoomRouter({ transcriptTracker } = {}) {
  const webhookRouter = express.Router();

  webhookRouter.post('/', async (req, res) => {
  const event = req.body;

  // Zoom sends a validation request when you first set up the webhook
  if (event.event === 'endpoint.url_validation') {
    const crypto = require('crypto');
    const token  = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    const hash   = crypto.createHmac('sha256', token).update(event.payload.plainToken).digest('hex');
    return res.json({ plainToken: event.payload.plainToken, encryptedToken: hash });
  }

  if (event.event !== 'recording.transcript_completed') {
    return res.json({ status: 'ignored' });
  }

    const releaseTranscript = transcriptTracker?.accept();
    if (transcriptTracker && !releaseTranscript) {
      return res.status(503).json({ status: 'shutting_down' });
    }

    // Acknowledge immediately so Zoom doesn't retry
    res.json({ status: 'received' });

  try {
    const obj            = event.payload.object;
    const downloadToken  = event.download_token;
    const meetingId      = obj.id?.toString();
    const transcriptFile = obj.recording_files?.find(f => f.file_type === 'TRANSCRIPT');

    if (!transcriptFile) {
      console.log('[zoom] No transcript file in payload');
      return;
    }

    console.log(`[zoom] Processing transcript for meeting ${meetingId}`);

    const transcriptText = await downloadTranscript(transcriptFile.download_url, downloadToken);
    console.log(`[zoom] Transcript downloaded (${transcriptText.length} chars)`);

    const needsManualReview = transcriptText.length < 1000;
    const shareUrl = obj.share_url || null;

    const fields = await extractFields(transcriptText);
    if (!fields) throw new Error('Field extraction returned null');
    console.log('[zoom] Fields extracted:', JSON.stringify(fields, null, 2));

    const record = await findAppointmentRecord(meetingId);
    if (!record) {
      console.log(`[zoom] No Airtable record found for meeting ID ${meetingId}`);
      return;
    }

    await updateAirtableRecord(record.id, fields, needsManualReview, shareUrl);
    console.log(`[zoom] Airtable record ${record.id} updated successfully`);
  } catch (err) {
    console.error('[zoom] Error processing webhook:', err.message);
  } finally {
    releaseTranscript?.();
  }
  });

  return webhookRouter;
}

module.exports = createZoomRouter();
module.exports.createZoomRouter = createZoomRouter;
