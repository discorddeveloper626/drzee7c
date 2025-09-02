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
const useragent = require('useragent');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const webhookClient = new WebhookClient({ url: process.env.WEBHOOK_URL });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const authMap = new Map();
app.use(express.static('public'));

const isVPN = (ip) => {
  if (!ip || ip === 'unknown') return true;
  const cloudRanges = [
    /^3\./, /^13\./, /^15\./, /^18\./, /^34\./, /^35\./, /^44\./,
    /^52\./, /^54\./, /^64\.4/, /^65\./, /^66\./, /^67\./, /^70\./,
    /^71\./, /^72\./, /^73\./, /^74\./, /^75\./, /^76\./, /^96\./,
    /^104\./, /^107\./, /^108\./, /^128\./, /^129\./, /^131\./, /^132\./,
    /^143\./, /^144\./, /^146\./, /^147\./, /^149\./, /^150\./, /^152\./
  ];
  return cloudRanges.some((r) => r.test(ip));
};

// 認証ページ
app.get('/auth', (req, res) => {
  const state = uuidv4();
  authMap.set(state, true);

  const htmlPath = path.join(__dirname, 'public', 'auth.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html
    .replaceAll('{{CLIENT_ID}}', process.env.CLIENT_ID)
    .replaceAll('{{REDIRECT_URI}}', process.env.REDIRECT_URI)
    .replaceAll('{{STATE}}', state)
    .replaceAll('{{SCOPE}}', 'identify%20email');

  res.send(html);
});

// OAuth2 コールバック
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const ip = req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress || 'unknown';

  if (!code || !state || !authMap.has(state)) {
    return res.sendFile(path.join(__dirname, 'public', 'error.html'));
  }

  if (isVPN(ip)) {
    return res.sendFile(path.join(__dirname, 'public', 'vpn_error.html'));
  }

  try {
    const { data: existing } = await supabase.from('users').select('*').eq('ip', ip).single();
    if (existing) return res.sendFile(path.join(__dirname, 'public', 'ip_used_error.html'));

    if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET || !process.env.REDIRECT_URI) {
      console.error('❌ OAuth2 環境変数未設定');
      return res.sendFile(path.join(__dirname, 'public', 'error.html'));
    }

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'DiscordBot (https://drzee7c.onrender.com, 1.0.0)',
      },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        scope: 'identify email',
      }),
    });

    const rawToken = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(rawToken);
    } catch (e) {
      console.error('❌ JSON パース失敗 →', rawToken.slice(0, 500));
      return res.sendFile(path.join(__dirname, 'public', 'error.html'));
    }

    if (!tokenData.access_token) {
      console.error('❌ トークン取得失敗:', tokenData);
      return res.sendFile(path.join(__dirname, 'public', 'error.html'));
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'DiscordBot (https://drzee7c.onrender.com, 1.0.0)',
      },
    });
    const user = await userRes.json();
    const displayName = user.global_name ?? `${user.username}${user.discriminator ? `#${user.discriminator}` : ''}`;

    const ua = useragent.parse(req.headers['user-agent']);
    const osBrowser = `${ua.os.toString()} ${ua.toAgent()}`;

    const { error } = await supabase.from('users').upsert({
      id: user.id,
      username: displayName,
      email: user.email ?? null,
      ip,
      os_browser: osBrowser,
    });
    if (error) console.error('❌ Supabase 保存失敗:', error);
    else console.log('✅ Supabase 保存成功:', displayName);

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.roles.fetch();
    const member = await guild.members.fetch(user.id).catch(() => null);
    const role = guild.roles.cache.get(process.env.ROLE_ID);
    if (member && role) await member.roles.add(role);

    await webhookClient.send({
      embeds: [
        {
          title: '認証完了',
          color: 0x00ff00,
          fields: [
            { name: '👤｜ユーザー名', value: displayName },
            { name: '🆔｜ユーザーID', value: user.id },
            { name: '📩｜メールアドレス', value: user.email ?? '取得失敗' },
            { name: '📍｜IPアドレス', value: ip },
            { name: '🌏｜OS / ブラウザ', value: osBrowser },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    res.sendFile(path.join(__dirname, 'public', 'success.html'));
    authMap.delete(state);
  } catch (err) {
    console.error('OAuth2 処理エラー:', err);
    res.sendFile(path.join(__dirname, 'public', 'error.html'));
  }
});

// Discord ready
client.once(Events.ClientReady, () => console.log(`✅ Logged in as ${client.user.tag}`));

// /verify コマンド
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'verify') return;

  try {
    const embed = new EmbedBuilder()
      .setTitle('認証 ¦ Verify')
      .setDescription('下のボタンを押して認証してください。')
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setLabel('✅｜認証 / Verify')
      .setStyle(ButtonStyle.Link)
      .setURL(`${process.env.REDIRECT_URI.replace('/callback','/auth')}`);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Interaction エラー:', err);
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
          .setDescription('認証パネルを設置します。')
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
