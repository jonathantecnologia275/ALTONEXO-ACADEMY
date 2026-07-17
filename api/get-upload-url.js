// api/get-upload-url.js
// Generates a short-lived presigned URL that lets the browser upload a video
// file DIRECTLY to Cloudflare R2 (bypassing Vercel's function size limits).
// Only works for accounts marked is_admin = true in Supabase.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const SUPABASE_URL = 'https://qmpoxscqjgtnlipadnmq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_AbWohQb6y4oozbcH-t4nyw_PrDW8n4G';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { access_token, filename, contentType } = req.body || {};

  if (!access_token || !filename) {
    return res.status(400).json({ error: 'Missing access_token or filename' });
  }

  try {
    // 1. Verify the token belongs to a real, logged-in Supabase user
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const user = await userResp.json();

    // 2. Verify this user is an admin (respects RLS: users can read their own profile row)
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          apikey: SUPABASE_ANON_KEY,
        },
      }
    );
    const profileData = await profileResp.json();
    const isAdmin = Array.isArray(profileData) && profileData[0]?.is_admin === true;

    if (!isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // 3. Build the R2 (S3-compatible) client
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    // 4. Create a unique object key and a presigned PUT URL (valid 10 minutes)
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `videos/${Date.now()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'video/mp4',
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

    return res.status(200).json({ uploadUrl, publicUrl });
  } catch (err) {
    console.error('get-upload-url error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}