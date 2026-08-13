# 🐰 Rabbit AI Avatar

日本語で会話できるAIライブアバターシステム。テキストベースのアバター表示で感情を表現し、映画情報のデータベース検索にも対応しています。

## ✨ 機能

- **音声入力**: AWS Transcribe Streamingによるリアルタイム音声認識 (STS一時認証情報使用)
- **セキュア認証**: STS一時トークンによる安全なAWS認証 (本番環境対応)
- **自動フォールバック**: AWS障害時にWeb Speech APIへ自動切り替え
- **RNNoise統合**: Mozilla製AIノイズ除去対応 (デフォルトOFF、日本語認識精度優先)
- **バージイン対応**: AIの話し中に割り込んで新しい質問が可能
- **自動停止**: 10秒無音検知、タブ非表示時の自動停止でコスト削減
- **日本語会話**: Claude 3.5 Haikuによる自然な日本語会話
- **感情表現**: Lottieアニメーションで感情を表現
- **音声出力**: Azure Neural TTSによる感情豊かな音声合成
- **映画検索**: データベースから映画情報を検索して回答
- **会話履歴**: MySQLに会話を保存し、ドメイン別(movie/gourmet/general)にコンテキスト管理
- **ユーザー認証**: トークンベースの認証とパーソナライズされた会話
- **ユーザーアーカイブ**: 映画やグルメ情報を個人アーカイブに保存 (NEW!)
- **リアルタイム**: WebSocketによる低遅延通信

## 🏗️ アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                       │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Voice Input      │  │ WebSocket    │  │ Lottie Avatar │ │
│  │ (AWS Transcribe) │  │              │  │ Display       │ │
│  └────────┬─────────┘  └──────────────┘  └───────────────┘ │
│           │                     ▲                            │
│           ▼                     │                            │
│  ┌────────────────────┐         │                           │
│  │ AWS Transcribe     │         │ (Text + Audio only)       │
│  │ Streaming          │         │                           │
│  │ (Frontend Direct)  │         │                           │
│  └────────────────────┘         │                           │
└──────────────────────────────────┼───────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  Backend (Node.js/Express)                   │
│  ┌─────────────┐  ┌──────────────────────┐                 │
│  │ Claude 3.5  │  │ Azure Neural TTS     │                 │
│  │ Haiku       │→ │ (Nanami/Keita)       │                 │
│  └──────┬──────┘  └──────────────────────┘                 │
│         │                                                    │
│  ┌──────▼───────────┐                                       │
│  │ MySQL            │                                       │
│  │ (User/History)   │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

📊 **詳細なワークフロー図は [WORKFLOW.md](./WORKFLOW.md) を参照してください。**

- 全体フロー図（12ステップ）
- シーケンス図
- パフォーマンスタイムライン
- 感情フロー
- 映画検索Tool Useフロー

🔇 **音質改善・ノイズ除去については [RNNOISE_INTEGRATION.md](./RNNOISE_INTEGRATION.md) を参照してください。**

- RNNoise統合の詳細
- オーディオパイプラインの説明
- テスト方法とパフォーマンス
- エコー問題の解決方法
- ⚠️ **日本語認識の最適化**: [RNNOISE_JAPANESE_ISSUE.md](./RNNOISE_JAPANESE_ISSUE.md)
  - RNNoiseはデフォルトOFF (日本語認識精度優先)
  - 必要に応じて有効化可能

🎙️ **バージイン設定については [BARGE_IN_CONFIG.md](./BARGE_IN_CONFIG.md) を参照してください。**

- 最小文字数閾値の設定
- 誤検知防止の仕組み
- 推奨設定値とカスタマイズ方法

## 📋 必要条件

- Node.js 18+
- MySQL 8+ (既存サーバーに接続 — ローカルDockerコンテナは不要)
- 以下のAPIキー:
  - **AWS Credentials** (Transcribe用、**必須** - 音声入力に使用)
  - Anthropic API Key (Claude)
  - Azure Speech Services Key

## 🚀 セットアップ

### 1. リポジトリのクローン

```bash
cd /path/to/rabbit
```

### 2. 依存関係のインストール

```bash
npm run install:all
```

### 3. 環境変数の設定

#### バックエンド

```bash
cp backend/.env.example backend/.env
```

以下の値を設定:

```env
# Server Configuration
PORT=3001
CORS_ORIGIN=http://localhost:3000

# Anthropic Claude API (required)
ANTHROPIC_API_KEY=your_anthropic_api_key

# Azure Speech Services (required)
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=japaneast

# MySQL Database (既存サーバー)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=rabbit_movies
DB_USER=root
DB_PASSWORD=
DB_SSL=false
```

#### フロントエンド (AWS Transcribe用)

```bash
cd frontend
```

`.env.local` ファイルを作成:

```env
# AWS Transcribe Configuration (Frontend Direct)
# ⚠️ FOR DEMO ONLY - In production, use AWS Cognito for temporary credentials
NEXT_PUBLIC_AWS_REGION=us-west-2
NEXT_PUBLIC_AWS_ACCESS_KEY_ID=your_access_key_here
NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY=your_secret_key_here

# WebSocket Backend URL
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws

# Waiting Audio Configuration
# Delay (in milliseconds) before playing random waiting audio after message submission
# Default: 300ms (0.3 seconds)
NEXT_PUBLIC_WAITING_DELAY=300

# Barge-in Configuration
# Minimum number of characters required before submitting transcribed text (final transcript)
# This prevents meaningless single-character submissions during barge-in
# Default: 5 (recommended to avoid false triggers)
NEXT_PUBLIC_BARGE_IN_MIN_CHARS=5

# Early Barge-in Detection (using partial transcripts)
# Minimum characters in partial transcript to trigger TTS stop
# This provides faster response (~300-500ms faster) before final transcript arrives
# Default: 2 (lower = faster but more false positives, higher = slower but more accurate)
NEXT_PUBLIC_EARLY_BARGE_IN_MIN_CHARS=2
```

**重要:** フロントエンドのAWS認証情報について
- **デモ版**: 直接認証情報を設定 (現在の実装)
- **本番環境**: AWS Cognitoを使用した一時認証情報を推奨
- 詳細は [AWS_TRANSCRIBE_SETUP.md](./AWS_TRANSCRIBE_SETUP.md) を参照

### 4. データベースの起動

```bash
docker-compose up -d
```

### 5. データベースのセットアップ

```bash
npm run db:setup
```

このコマンドで以下が作成されます（MySQL、既に存在する場合はスキップされます):
- `conversation_history` テーブル: 会話履歴（ドメイン付き）
- `user_profile` テーブル: ユーザープロフィール
- `user_archive` テーブル: ユーザーアーカイブ（映画・グルメ保存機能）

映画・レストラン検索は外部OpenSearch APIを使用するため、ローカルDBにテーブルはありません。

### 6. 開発サーバーの起動

```bash
npm run dev
```

- フロントエンド: http://localhost:3000
- バックエンド: http://localhost:3001
- WebSocket: ws://localhost:3001/ws

## 📁 プロジェクト構造

```
rabbit/
├── frontend/                 # Next.js フロントエンド
│   ├── src/
│   │   ├── app/             # App Router ページ
│   │   ├── components/      # React コンポーネント
│   │   ├── hooks/           # カスタムフック
│   │   └── types/           # TypeScript 型定義
│   └── package.json
│
├── backend/                  # Node.js バックエンド
│   ├── src/
│   │   ├── config/          # 設定
│   │   ├── db/              # データベース接続・クエリ
│   │   ├── services/        # 外部サービス連携
│   │   ├── types/           # 型定義
│   │   ├── websocket/       # WebSocketハンドラ
│   │   └── index.ts         # エントリーポイント
│   └── package.json
│
├── docker-compose.yml        # backend/frontend (MySQLは既存サーバーに接続)
├── package.json             # ルートパッケージ
└── README.md
```

## 📚 ユーザーアーカイブ機能

会話中に気になった映画やレストランを個人アーカイブに保存できます:

### 使い方

1. **UIから保存**: 
   - 映画やグルメの応答に 📚 アイコンが自動表示
   - 📚 アイコンをクリック
   - ✓ に変わり保存完了

2. **対象メッセージ**:
   - 映画についての会話（自動検出）
   - グルメについての会話（自動検出）

### API エンドポイント

```bash
# 保存
POST /api/archive

# 取得（ドメインでフィルタ可能）
GET /api/archive/:userId?domain=movie

# 削除
DELETE /api/archive

# 存在確認
GET /api/archive/:userId/:domain/:itemId
```

詳細は [ARCHIVE_FEATURE.md](./ARCHIVE_FEATURE.md) を参照してください。

## 🎭 感情表現

ラビットは以下の感情を表現します:

| 感情 | 顔文字 | 色 |
|------|--------|-----|
| 普通 | (・ω・) | グレー |
| 嬉しい | (◕‿◕) | イエロー |
| ワクワク | (★▽★) | レッド |
| 考え中 | (・_・?) | シアン |
| 悲しい | (´・ω・`) | グレー |
| 驚き | (°o°) | オレンジ |
| 困惑 | (・・?) | パープル |
| 聞いています | (・ω・)🎤 | グリーン |
| 話しています | (・ω・)♪ | ブルー |

## 🎬 映画検索機能

「おすすめの映画は？」「宮崎駿の映画を教えて」などと質問すると、データベースから映画情報を検索して回答します。

サンプルデータには以下の映画が含まれています:
- 千と千尋の神隠し
- 君の名は。
- もののけ姫
- 七人の侍
- その他多数

## 🔧 技術スタック

| コンポーネント | 技術 |
|---------------|------|
| STT | AWS Transcribe Streaming (Frontend Direct) |
| LLM | Claude 3.5 Haiku |
| TTS | Azure Neural TTS (ja-JP-NanamiNeural) |
| Avatar | Lottie Animations |
| Frontend | Next.js 15, React 18, TypeScript |
| Backend | Node.js, Express, WebSocket |
| Database | MySQL |

## 💾 会話履歴とドメイン管理

会話履歴は自動的にMySQLデータベースに保存され、ドメイン別にコンテキストが管理されます。

### ドメインタイプ

会話内容から自動的にドメインを検出:

| ドメイン | 説明 | キーワード例 |
|---------|------|-------------|
| `movie` | 映画関連の会話 | 映画、アニメ、監督、俳優、ジャンル |
| `gourmet` | グルメ関連の会話 | レストラン、料理、カフェ、メニュー |
| `general` | 一般的な会話 | その他すべて |

### データベーススキーマ

```sql
CREATE TABLE conversation_history (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),                -- ユーザーID (任意)
  user_name VARCHAR(255),              -- ユーザー名 (任意)
  user_token TEXT,                     -- 認証トークン (任意)
  role VARCHAR(20) NOT NULL,           -- 'user' or 'assistant'
  content TEXT NOT NULL,               -- 会話内容
  domain VARCHAR(50) NOT NULL,         -- 'movie', 'gourmet', 'general'
  emotion VARCHAR(20),                 -- AIの感情 (assistantの場合)
  created_at TIMESTAMP DEFAULT NOW()
);
```

### インデックス

高速検索のため以下のインデックスを作成:
- `session_id`: セッション別の会話履歴取得
- `user_id`: ユーザー別の会話履歴取得
- `domain`: ドメイン別の会話分析
- `created_at`: 時系列順の取得
- `session_id + domain`: セッション内のドメイン別履歴
- `user_id + domain`: ユーザーのドメイン別履歴

### 使用例

```typescript
import { 
  getConversationHistory, 
  getConversationHistoryByUserId,
  getRecentHistoryByDomain,
  getConversationStats,
  getUniqueUsers
} from './db/conversation.js';

// セッションの会話履歴を取得
const history = await getConversationHistory('session-123');

// 映画ドメインの会話のみ取得
const movieHistory = await getConversationHistory('session-123', 'movie');

// ユーザーの全会話を取得
const userHistory = await getConversationHistoryByUserId('user-789');

// ユーザーの映画会話のみ取得
const userMovies = await getConversationHistoryByUserId('user-789', 'movie');

// 最近の映画関連の会話を取得（全セッション）
const recentMovies = await getRecentHistoryByDomain('movie', 100);

// ユーザー一覧と活動状況
const users = await getUniqueUsers();

// ドメイン別の統計情報
const stats = await getConversationStats();
// => { movie: { total: 1500, sessions: 45 }, gourmet: { total: 300, sessions: 12 }, ... }
```

### 自動ドメイン検出

ユーザーメッセージから自動的にドメインを検出し、会話履歴に記録:

```typescript
// 例: "アクション映画を探しています"
// → ドメイン: movie

// 例: "美味しいラーメン屋を教えて"
// → ドメイン: gourmet

// 例: "今日の天気は？"
// → ドメイン: general
```

### ユーザー情報の設定

WebSocket接続後、ユーザー情報を設定できます:

```typescript
// フロントエンドから送信
ws.send(JSON.stringify({
  type: "set_user_info",
  userId: "user-789",
  userName: "山田太郎",
  userToken: "auth-token-xyz"  // 任意
}));
```

設定後の会話は自動的にユーザー情報と共に保存されます。

### ユーザー認証とパーソナライゼーション

トークンベースの認証により、ユーザー情報を活用したパーソナライズされた会話が可能です。

#### REST API

```bash
# ユーザー情報を取得（トークン指定）
GET /api/auth/user?token=usr_xxx

```

#### 使用例

```typescript
// 1. トークン取得
const res = await fetch('http://localhost:3001/api/auth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usersId: 1 })
});
const { token } = await res.json();

// 2. WebSocket接続時にトークン送信
ws.send(JSON.stringify({
  type: 'set_user_info',
  userToken: token
}));

// 3. AIは自動的にユーザー情報を活用
// - 年齢に応じたコンテンツ推薦
// - 興味・趣味に基づいた提案
// - 地域に応じた情報提供
```

詳細は **[USER_AUTHENTICATION.md](./USER_AUTHENTICATION.md)** を参照してください。

## 🎤 音声入力とバージイン機能

### 音声入力の使い方

1. マイクボタンをクリック
2. マイクアクセスを許可
3. 話し始める
4. リアルタイムで文字起こしが表示される
5. 話し終わると自動的にメッセージが送信される

### バージイン機能

**AIが話している最中に割り込めます:**

1. AIが音声応答を再生中
2. マイクボタンをクリックして話し始める
3. **自動的に以下が実行されます:**
   - 現在の音声再生が即座に停止
   - 音声キューがクリア
   - あなたの音声が文字起こしされる
   - 新しい応答が生成される

**デモ:** "映画を教えて" と質問 → AIが回答中 → 割り込んで "アニメ映画" と追加質問

### 技術詳細

詳しい実装方法、セットアップ手順、トラブルシューティングは以下を参照:

📘 **[AWS_TRANSCRIBE_SETUP.md](./AWS_TRANSCRIBE_SETUP.md)** - 完全なドキュメント

主な機能:
- フロントエンドから直接AWS Transcribeに接続
- リアルタイム音声ストリーミング (16kHz PCM)
- 途中結果の安定化機能
- バージイン検出とオーディオ制御
- エラーハンドリングと再接続

## 📝 API

### WebSocket メッセージ

**クライアント → サーバー:**

```json
// テキスト入力
{ "type": "text_input", "text": "こんにちは" }

// ユーザー情報設定
{ 
  "type": "set_user_info", 
  "userId": "user-789",
  "userName": "山田太郎",
  "userToken": "auth-token-xyz"
}

// リスニング開始
{ "type": "start_listening" }

// リスニング停止
{ "type": "stop_listening" }
```

**サーバー → クライアント:**

```json
// 接続成功
{ "type": "connected", "sessionId": "...", "message": "..." }

// ステータス更新
{ "type": "status", "status": "thinking", "emotion": "thinking", "statusText": "考え中..." }

// ユーザーメッセージ
{ "type": "user_message", "text": "こんにちは" }

// アシスタントメッセージ
{ "type": "assistant_message", "text": "...", "emotion": "happy" }

// 音声データ
{ "type": "audio", "data": "base64...", "format": "mp3" }
```

## 🐛 トラブルシューティング

### データベースに接続できない

MySQLは既存サーバーに接続する構成のため、ローカルDBコンテナはありません。`backend/.env` の `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD` が正しいか確認してください。

```bash
# MySQLサーバーへの接続確認
mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p

# テーブル作成 (初回のみ)
npm run db:setup
```

### 音声が再生されない

- ブラウザの音声自動再生ポリシーにより、最初のユーザーインタラクション後に音声が再生されます
- Azure Speech Key が正しく設定されているか確認してください

### Claude APIエラー

- `ANTHROPIC_API_KEY` が正しく設定されているか確認
- APIキーに十分なクレジットがあるか確認

## 📚 ドキュメント

- **[STT_QUICK_START.md](./STT_QUICK_START.md)**: 音声認識クイックスタートガイド
  - 5分でセットアップ
  - 使い方とサンプルコード
  - トラブルシューティング
- **[STT_QUALITY_DEGRADATION.md](./STT_QUALITY_DEGRADATION.md)**: 音声認識品質低下の解決 (NEW!)
  - 時間経過による品質低下の原因
  - 自動セッションリフレッシュ機能
  - 95%精度を無期限に維持
- **[AWS_TRANSCRIBE_HYBRID.md](./AWS_TRANSCRIBE_HYBRID.md)**: AWS Transcribe ハイブリッド実装ガイド
  - STS一時認証情報の実装
  - Web Speech APIフォールバック
  - 自動停止機能
  - セキュリティベストプラクティス
- **[CLAUDE.md](./CLAUDE.md)**: プロジェクト概要とコマンドリファレンス
- **[WORKFLOW.md](./WORKFLOW.md)**: 開発ワークフローとベストプラクティス

## 📄 ライセンス

MIT License
