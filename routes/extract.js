const express = require('express');
const multer = require('multer');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const EXTRACTION_PROMPT = `You are reading a photo of an electrical test-and-tag item. It may show:
- a test tag sticker (a coloured tag printed with a tag number, test date, and pass/fail/electrician details)
- a plant/asset number sticker
- the appliance's own nameplate (brand, model, serial number, electrical rating)

Return ONLY a JSON object, no markdown fences, no preamble, with this exact shape:
{
  "tag_no": string or null,          // the number printed on the TEST TAG sticker itself - this is the primary identifier
  "plant_no": string or null,        // a separate asset/plant number sticker if present (often just a small number)
  "appliance": string or null,       // what the item is, e.g. "Microwave", "Extension lead", "Angle grinder"
  "brand": string or null,
  "model_no": string or null,
  "serial_no": string or null,
  "test_date_on_tag": string or null,   // ISO YYYY-MM-DD if the tag shows a printed test date, else raw text
  "pass_fail_on_tag": string or null,   // "pass", "fail", or "repairable" only if explicitly marked on the tag, else null
  "confidence_notes": string or null    // brief note on anything illegible, ambiguous, or missing
}

If a field is not visible or not legible, use null - do not guess or invent a tag number, plant number, or serial number.`;

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded (field name: photo).' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
              { type: 'text', text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Vision extraction failed upstream.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text : '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse extraction JSON:', cleaned);
      return res.status(502).json({ error: 'Could not parse extraction result.', raw: cleaned });
    }

    res.json({ extracted });
  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ error: 'Server error during extraction.' });
  }
});

module.exports = router;
