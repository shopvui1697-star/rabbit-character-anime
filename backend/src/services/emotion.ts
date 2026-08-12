import type { EmotionType } from "../types/index.js";

/**
 * Emotion detection and mapping utilities
 */

// Emotion keywords for detection (English)
const EMOTION_KEYWORDS: Record<EmotionType, string[]> = {
  happy: [
    "happy", "glad", "great", "awesome", "nice", "good", "love", "thanks", "thank you",
    "wonderful", "perfect", "excited"
  ],
  excited: [
    "wow", "amazing", "incredible", "yes", "yay", "cool", "fun", "interesting", "awesome"
  ],
  sad: [
    "sad", "sorry", "unfortunately", "miss", "lonely", "tough", "hard", "upset", "disappointed"
  ],
  surprised: [
    "surprised", "really", "wait", "what", "no way", "unexpected", "actually"
  ],
  thinking: [
    "think", "maybe", "probably", "perhaps", "not sure", "wonder", "hard to say", "difficult"
  ],
  confused: [
    "confused", "don't understand", "not sure", "hmm", "what do you mean", "unclear"
  ],
  neutral: [],
  listening: [],
  speaking: [],
};

/**
 * Detect emotion from text content
 * Returns the most likely emotion based on keyword matching
 */
export function detectEmotion(text: string): EmotionType {
  const lowerText = text.toLowerCase();
  
  // Count matches for each emotion
  const scores: Record<EmotionType, number> = {
    happy: 0,
    excited: 0,
    sad: 0,
    surprised: 0,
    thinking: 0,
    confused: 0,
    neutral: 0,
    listening: 0,
    speaking: 0,
  };

  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        scores[emotion as EmotionType]++;
      }
    }
  }

  // Find emotion with highest score
  let maxScore = 0;
  let detectedEmotion: EmotionType = "neutral";

  for (const [emotion, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detectedEmotion = emotion as EmotionType;
    }
  }

  return detectedEmotion;
}

/**
 * Get emotion intensity (0.0 - 1.0) based on text analysis
 */
export function getEmotionIntensity(text: string, emotion: EmotionType): number {
  const keywords = EMOTION_KEYWORDS[emotion];
  if (!keywords || keywords.length === 0) return 0.5;

  let matchCount = 0;
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      matchCount++;
    }
  }

  // Normalize to 0.5 - 1.0 range
  return Math.min(0.5 + (matchCount * 0.1), 1.0);
}

/**
 * Emotion display data
 */
export const EMOTION_DISPLAY: Record<
  EmotionType,
  { face: string; label: string; color: string }
> = {
  neutral: { face: "(・ω・)", label: "Neutral", color: "#6B7280" },
  happy: { face: "(◕‿◕)", label: "Happy", color: "#F59E0B" },
  excited: { face: "(★▽★)", label: "Excited", color: "#EF4444" },
  thinking: { face: "(・_・?)", label: "Thinking", color: "#06B6D4" },
  sad: { face: "(´・ω・`)", label: "Sad", color: "#6B7280" },
  surprised: { face: "(°o°)", label: "Surprised", color: "#F59E0B" },
  confused: { face: "(・・?)", label: "Confused", color: "#8B5CF6" },
  listening: { face: "(・ω・)🎤", label: "Listening", color: "#10B981" },
  speaking: { face: "(・ω・)♪", label: "Speaking", color: "#3B82F6" },
};
