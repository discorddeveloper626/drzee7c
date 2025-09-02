const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  WebhookClient,
} = require('discord.js');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const webhookClient = new WebhookClient({
  url: process.env.WEBHOOK_URL,
});

// Supabase クライアント
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const authMap = new Map();
app.use(express.static('public'));

// 認証ページ
app.get('/auth', (req, res) => {
  const state = uuidv4();
  authMap.set(state, true);

  const filePath = path.join(__dirname, 'public', 'auth.html');
  let html = fs.readFileSync(filePath, 'utf-8');

  html = html
    .replace('{{CLIENT_ID}}', process.env.CLIENT_ID)
    .replace('{{REDIRECT_URI}}', process.env.REDIRECT_URI)
    .replace('{{STATE}}', state)
    .replace('{{SCOPE}}', 'identify%20email');

  res.send(html);
});

// コールバック処理
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const ip =
    req.headers['x-forwarded-for']?.split(',').shift() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!code || !state || !authMap.has(state)) {
    return res.sendFile(path.join(__dirname, 'public', 'error.html'));
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        scope: 'identify email',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.sendFile(path.join(__dirname, 'public', 'error.html'));
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // Supabase 保存
    try {
      const { error } = await supabase
        .from('users')
        .upsert({
          id: user.id,
          username: `${user.username}#${user.discriminator}`,
          email: user.email ?? null,
          ip: ip,
        });

      if (error) console.error('Supabase 保存失敗:', error);
      else console.log('Supabase 保存成功:', user.username);
    } catch (dbErr) {
      console.error('Supabase処理エラー:', dbErr);
    }

    // ロール付与
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.roles.fetch();

    const member = await guild.members.fetch(user.id).catch(() => null);
    const role = guild.roles.cache.get(process.env.ROLE_ID);

    if (member && role) {
      await member.roles.add(role);
      console.log(`✅ ロール付与成功: ${user.username}#${user.discriminator}`);
    }

    // Webhook送信
    try {
      await webhookClient.send({
        embeds: [
          {
            title: '✅ 認証完了',
            color: 0x00ff00,
            fields: [
              { name: 'ユーザー名', value: `${user.username}#${user.discriminator}` },
              { name: 'ユーザーID', value: user.id },
              { name: 'メールアドレス', value: user.email ?? '取得失敗' },
              { name: 'IPアドレス', value: ip },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err) {
      console.error('Webhook送信失敗:', err);
    }

    res.sendFile(path.join(__dirname, 'public', 'success.html'));
    authMap.delete(state);
  } catch (err) {
    console.error('OAuth2 処理エラー:', err);
    res.sendFile(path.join(__dirname, 'public', 'error.html'));
  }
});

// ユーザー情報チェック用 API
app.get('/user-info/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'ユーザー情報が見つかりません' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '内部エラー' });
  }
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'verify') {
    const embed = new EmbedBuilder()
      .setTitle('🔐 認証 / Verify')
      .setDescription('下のボタンを押して認証をしてください。')
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setLabel('✅｜認証 / Verify')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://${process.env.DOMAIN}/auth`);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row] });
  }
});

// コマンド登録
(async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [
        new SlashCommandBuilder()
          .setName('verify')
          .setDescription('Discordアカウントで認証します')
          .toJSON(),
      ],
    });
    console.log('✅ コマンド登録完了');
  } catch (e) {
    console.error('コマンド登録エラー:', e);
  }
})();

client.login(process.env.TOKEN);
app.listen(port, () => console.log(`🌐 Web server started on port ${port}`));
