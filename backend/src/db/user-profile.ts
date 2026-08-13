import { pool } from "./connection.js";

/**
 * User profile interface matching database schema
 */
export interface UserProfile {
  id: number;
  users_id: number;
  name?: string;
  contact_email_address?: string;
  nick_name?: string;
  birthday?: Date;
  gender?: string;
  nationality?: string;
  prefecture?: string;
  district?: string;
  image_url?: string;
  is_feature?: number;
  introduction?: string;
  twitter_url?: string;
  instagram_url?: string;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
  is_push?: number;
  facebook_url?: string;
  read_nickname?: string;
  first_setup_notice?: number;
  user_search?: string;
  province?: string;
}

/**
 * User context for LLM - simplified user info for conversation
 */
export interface UserContext {
  userId: number;
  nickName: string;
  birthday?: string;
  age?: number;
  gender?: string;
  introduction?: string;
  province?: string;
  interests?: string[];
}

/**
 * Get random user profile for demo mode
 */
export async function getRandomUser(): Promise<UserProfile | null> {
  try {
    const result = await pool.query(
      `SELECT * FROM user_profile
       WHERE deleted_at IS NULL
       ORDER BY RAND()
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error("Failed to get random user:", error);
    return null;
  }
}


/**
 * Convert user profile to conversation context for LLM
 */
export function userProfileToContext(profile: UserProfile): UserContext {
  // Calculate age from birthday
  let age: number | undefined;
  if (profile.birthday) {
    const birthDate = new Date(profile.birthday);
    const today = new Date();
    age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
  }

  // Extract interests from introduction
  const interests: string[] = [];
  if (profile.introduction) {
    // Simple keyword extraction for common interests
    const interestKeywords = [
      '映画', 'アニメ', 'ゲーム', 'ドラマ', '音楽', 'スポーツ',
      '旅行', 'グルメ', '料理', '読書', '写真', 'アート',
      'SF', 'ホラー', 'アクション', 'コメディ', 'ロマンス'
    ];
    
    for (const keyword of interestKeywords) {
      if (profile.introduction.includes(keyword)) {
        interests.push(keyword);
      }
    }
  }

  return {
    userId: profile.users_id,
    nickName: profile.nick_name || profile.read_nickname || `ユーザー${profile.users_id}`,
    birthday: profile.birthday ? new Date(profile.birthday).toISOString().split('T')[0] : undefined,
    age,
    gender: profile.gender || undefined,
    introduction: profile.introduction || undefined,
    province: profile.province || profile.prefecture || undefined,
    interests: interests.length > 0 ? interests : undefined,
  };
}

