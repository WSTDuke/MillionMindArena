import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from './supabase';

// Utility Interaces

export interface TriviaQuestion {
    category: string;
    type: string;
    difficulty: string;
    question: string;
    correct_answer: string;
    incorrect_answers: string[];
}

export interface ProcessedQuestion {
    text: string;
    options: string[];
    correctAnswer: number;
}

interface RawQuestion {
    text: string;
    correct: string;
    incorrect: string[];
}

/**
 * Decodes HTML entities in a string.
 */
function decodeHtmlEntities(text: string): string {
    const textArea = document.createElement('textarea');
    textArea.innerHTML = text;
    return textArea.value;
}

/**
 * Helper to wait for a period of time.
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Global variables to handle API rate limits and state
 */
/**
 * Global variables to handle API rate limits and state
 */
let activeFetchPromise: Promise<ProcessedQuestion[]> | null = null;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 12000; // 12 seconds
let geminiBroken = localStorage.getItem('gemini_broken') === 'true';

/**
 * CẤU HÌNH PROMPT MỚI THÔNG MINH HƠN
 */
const SYSTEM_PROMPT = `Bạn là một chuyên gia biên dịch câu đố (Trivia Master) thông thái.
Nhiệm vụ: Bản địa hóa (Localize) dữ liệu câu hỏi từ tiếng Anh sang tiếng Việt.

QUY TẮC DỊCH THUẬT (BẮT BUỘC):

1. TÊN RIÊNG & THƯƠNG HIỆU (PROPER NOUNS):
   - GIỮ NGUYÊN TIẾNG ANH: Tên các tác phẩm (Phim, Game, Nhạc), thương hiệu, nhân vật (VD: Breaking Bad, Doctor Who, Portal, Marvel).
   - NGOẠI LỆ: Chỉ dịch khi tên đó đã CỰC KỲ PHỔ BIẾN tại Việt Nam (VD: "Back to the Future" -> "Trở lại tương lai", "The Lion King" -> "Vua Sư Tử").
   - Tên người: Giữ nguyên (VD: Albert Einstein, George Washington).

2. DỊCH THEO NGỮ CẢNH CHUYÊN MÔN:
   - KHÔNG dịch sát nghĩa từng chữ (Word-by-word).
   - "Level" (trong game) -> dịch là "Màn chơi" (tránh dùng "Mức độ").
   - "Franchise" -> dịch là "Thương hiệu" hoặc "Loạt phim/game".
   - Sử dụng thuật ngữ phù hợp với giới trẻ và game thủ.

3. CẤU TRÚC CÂU & VĂN PHONG QUYẾT ĐỊNH:
   - Đưa từ để hỏi (Ai, Cái gì, Năm nào...) về vị trí tự nhiên trong ngữ pháp tiếng Việt.
   - NHẤN MẠNH PHỦ ĐỊNH: Các từ phủ định trong câu hỏi PHẢI VIẾT HOA (VD: KHÔNG, KHÔNG PHẢI, NGOẠI TRỪ).
   - Văn phong súc tích, chuyên nghiệp dành cho trắc nghiệm (Quiz).

4. OUTPUT FORMAT:
   - CHỈ TRẢ VỀ MẢNG JSON. Không giải thích, không thêm text ngoài JSON.`;



/**
 * Fallback translation using Google Translate free API.
 */
async function translateBatchWithGoogle(texts: string[]): Promise<string[]> {
    // ... (Giữ nguyên code cũ)
    try {
        const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(texts.join('\n|||\n'))}`;
        // Try CodeTabs proxy which is often more permissive
        const url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(url);
        const data = await res.json();
        // codetabs returns the raw body directly
        const translatedResult = data[0].map((segment: [string, string, string, string]) => segment[0]).join('');
        return translatedResult.split('|||').map((s: string) => s.trim());
    } catch {
        // Suppress the error to a warning to not alarm the user; falling back to English is assumed behavior if proxy fails
        console.warn("Google Translation fallback failed (Proxy Error). Returning English questions.");
        return texts;
    }
}

/**
 * Translates a batch of strings using Gemini AI for high quality.
 */
async function translateBatchWithGemini(texts: string[]): Promise<string[]> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY?.trim();
    if (!apiKey || geminiBroken || apiKey.length < 10) {
        return translateBatchWithGoogle(texts);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
        }, { apiVersion: "v1" });

        // Cập nhật cách truyền prompt để đảm bảo Gemini hiểu rõ ngữ cảnh mảng
        const prompt = `${SYSTEM_PROMPT}\n\nINPUT DATA TO TRANSLATE:\n${JSON.stringify(texts)}`;
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        
        // Robust check: Remove markdown backticks if Gemini includes them
        if (text.includes("```")) {
            text = text.replace(/```json|```/g, "").trim();
        }
        
        const translatedArray = JSON.parse(text);
        
        if (Array.isArray(translatedArray) && translatedArray.length === texts.length) {
            return translatedArray;
        }
        throw new Error("Mismatched length");
    } catch (error) {
        // ... (Logic xử lý lỗi giữ nguyên)
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("404") || msg.includes("not found")) {
            geminiBroken = true;
            localStorage.setItem('gemini_broken', 'true');
            console.warn("Gemini resource not found (likely API/Endpoint mismatch). Switching to Google Translate.");
        } else {
            console.error("Gemini Error, falling back to Google:", msg);
        }
        return translateBatchWithGoogle(texts);
    }
}

/**
 * Fetches questions from Open Trivia DB.
 */
const FALLBACK_QUESTIONS: RawQuestion[] = [
    { text: "Thủ đô của Việt Nam là gì?", correct: "Hà Nội", incorrect: ["Hồ Chí Minh", "Đà Nẵng", "Hải Phòng"] },
    { text: "Ai là người phát minh ra bóng đèn điện?", correct: "Thomas Edison", incorrect: ["Nikola Tesla", "Alexander Graham Bell", "Albert Einstein"] },
    { text: "Hành tinh nào gần Mặt Trời nhất?", correct: "Sao Thủy", incorrect: ["Sao Kim", "Sao Hỏa", "Sao Trái Đất"] },
    { text: "Năm 2024 là năm con gì theo lịch âm?", correct: "Giáp Thìn (Rồng)", incorrect: ["Quý Mão (Mèo)", "Ất Tỵ (Rắn)", "Bính Ngọ (Ngựa)"] },
    { text: "Trong tin học, CPU là viết tắt của từ gì?", correct: "Central Processing Unit", incorrect: ["Central Power Unit", "Computer Processing Unit", "Control Processing Unit"] },
    { text: "Đỉnh núi cao nhất thế giới là đỉnh nào?", correct: "Everest", incorrect: ["K2", "Kangchenjunga", "Lhotse"] },
    { text: "Công thức hóa học của nước là gì?", correct: "H2O", incorrect: ["CO2", "O2", "HO"] },
    { text: "Ai đã viết Truyện Kiều?", correct: "Nguyễn Du", incorrect: ["Nguyễn Trãi", "Hồ Xuân Hương", "Nguyễn Khuyến"] },
    { text: "Bảng chữ cái tiếng Anh có bao nhiêu chữ cái?", correct: "26", incorrect: ["24", "25", "27"] },
    { text: "Đơn vị đo cường độ dòng điện là gì?", correct: "Ampe (A)", incorrect: ["Vôn (V)", "Ohm (Ω)", "Watt (W)"] },
    { text: "Châu lục nào lớn nhất thế giới?", correct: "Châu Á", incorrect: ["Châu Phi", "Châu Mỹ", "Châu Âu"] },
    { text: "Loài động vật nào chạy nhanh nhất trên cạn?", correct: "Báo Cheetah", incorrect: ["Sư tử", "Ngựa", "Linh dương"] },
    { text: "Màu nào không thuộc 7 sắc cầu vồng?", correct: "Đen", incorrect: ["Đỏ", "Xanh lam", "Tím"] },
    { text: "Quốc gia nào có diện tích lớn nhất thế giới?", correct: "Nga", incorrect: ["Trung Quốc", "Mỹ", "Canada"] },
    { text: "Ai là người sáng lập Microsoft?", correct: "Bill Gates", incorrect: ["Steve Jobs", "Mark Zuckerberg", "Jeff Bezos"] }
];

function getFallbackQuestions(amount: number): ProcessedQuestion[] {
    console.warn("Using Fallback Questions due to API failure.");
    const results: ProcessedQuestion[] = [];
    for (let i = 0; i < amount; i++) {
        const q = FALLBACK_QUESTIONS[i % FALLBACK_QUESTIONS.length];
        const options = [...q.incorrect];
        const correctIndex = Math.floor(Math.random() * (options.length + 1));
        options.splice(correctIndex, 0, q.correct);
        results.push({
            text: q.text,
            options: options,
            correctAnswer: correctIndex
        });
    }
    return results;
}

export async function fetchQuestions(
    amount: number = 30, 
    difficulty: string | null = null,
    userId?: string, 
    retries: number = 3
): Promise<ProcessedQuestion[]> {
    // Return existing promise if a fetch is already in progress
    if (activeFetchPromise) {
        console.log("Reusing ongoing fetchQuestions request...");
        return activeFetchPromise;
    }

    const fetchLogic = async (): Promise<ProcessedQuestion[]> => {
        let token = '';

        if (userId) {
            try {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('opentdb_token, opentdb_token_expires_at')
                    .eq('id', userId)
                    .single();

                const now = new Date();
                if (profile?.opentdb_token && profile.opentdb_token_expires_at && new Date(profile.opentdb_token_expires_at) > now) {
                    token = profile.opentdb_token;
                } else {
                    try {
                        const tokenRes = await fetch('https://opentdb.com/api_token.php?command=request');
                        const tokenData = await tokenRes.json();
                        if (tokenData.response_code === 0) {
                            token = tokenData.token;
                            const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
                            await supabase
                                .from('profiles')
                                .update({
                                    opentdb_token: token,
                                    opentdb_token_expires_at: expiresAt.toISOString()
                                })
                                .eq('id', userId);
                        }
                    } catch {
                        console.warn("Failed to get OpenTDB token, proceeding without it.");
                    }
                }
            } catch {
                console.warn("Profile fetch error in fetchQuestions, ignoring.");
            }
        }

        const url = `https://opentdb.com/api.php?amount=${amount}${token ? `&token=${token}` : ''}&type=multiple${difficulty ? `&difficulty=${difficulty}` : ''}`;
        
        // Global rate limit check
        const nowTime = Date.now();
        const timeSinceLastRequest = nowTime - lastRequestTime;
        if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
            const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            console.log(`Rate limit prevention: Waiting ${waitTime}ms...`);
            await sleep(waitTime);
        }

        lastRequestTime = Date.now();

        try {
            const res = await fetch(url);
            
            if (res.status === 429) {
                console.warn(`OpenTDB Rate Limit Hit (429). Retries left: ${retries}`);
                if (retries > 0) {
                    await sleep(MIN_REQUEST_INTERVAL + 2000); // Wait longer on 429
                    // Start a new chain for retry, detach from current promise wrapper logic to avoid infinite recursion complexity in this scope
                    // Actually, simpler to just recurse the main function, effectively starting a new "shared" promise if the lock was cleared.
                    // But here we affect the 'activeFetchPromise'. 
                    // To handle retry properly within the lock, we must do it here.
                    const retryResult = await fetchQuestions(amount, difficulty, userId, retries - 1);
                    return retryResult;
                }
                return getFallbackQuestions(amount);
            }

            const data = await res.json();
            
            if (data.response_code === 0) {
                const rawQuestions = data.results.map((q: TriviaQuestion) => {
                    const decodedQuestion = decodeHtmlEntities(q.question);
                    const decodedCorrect = decodeHtmlEntities(q.correct_answer);
                    const decodedIncorrect = q.incorrect_answers.map(decodeHtmlEntities);

                    return {
                        text: decodedQuestion,
                        correct: decodedCorrect,
                        incorrect: decodedIncorrect
                    };
                });

                // ... Translation Logic ...
                const translatedQuestions: ProcessedQuestion[] = [];
                
                try {
                    for (let i = 0; i < rawQuestions.length; i += 10) {
                        const batch = rawQuestions.slice(i, i + 10);
                        const stringsToTranslate: string[] = [];
                        batch.forEach((q: RawQuestion) => {
                            stringsToTranslate.push(q.text, q.correct, ...q.incorrect);
                        });

                        const translatedStrings = await translateBatchWithGemini(stringsToTranslate);
                        
                        let stringIdx = 0;
                        batch.forEach((q: RawQuestion) => {
                            const text = translatedStrings[stringIdx++] || q.text;
                            const correct = translatedStrings[stringIdx++] || q.correct;
                            const incorrect = [
                                translatedStrings[stringIdx++] || q.incorrect[0],
                                translatedStrings[stringIdx++] || q.incorrect[1],
                                translatedStrings[stringIdx++] || q.incorrect[2]
                            ];

                            const options = [...incorrect];
                            const randomIndex = Math.floor(Math.random() * (options.length + 1));
                            options.splice(randomIndex, 0, correct);

                            const capitalize = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

                            translatedQuestions.push({
                                text,
                                options: options.map(capitalize),
                                correctAnswer: randomIndex
                            });
                        });
                    }
                    return translatedQuestions;
                } catch (translateError) {
                    console.error("Translation failed, returning raw questions:", translateError);
                    return rawQuestions.map((q: RawQuestion) => {
                        const options = [...q.incorrect];
                        const randomIndex = Math.floor(Math.random() * (options.length + 1));
                        options.splice(randomIndex, 0, q.correct);
                        return {
                            text: q.text,
                            options: options,
                            correctAnswer: randomIndex
                        };
                    });
                }

            } else if (data.response_code === 5 && retries > 0) {
                console.warn(`OpenTDB Response Code 5 (Rate Limit). Retrying...`);
                await sleep(MIN_REQUEST_INTERVAL + 2000);
                return fetchQuestions(amount, difficulty, userId, retries - 1);
            } else if (data.response_code === 4 && userId) {
                console.log("Token empty. Resetting...");
                await fetch(`https://opentdb.com/api_token.php?command=reset&token=${token}`);
                return fetchQuestions(amount, difficulty, userId, retries); 
            }

            console.error(`Failed to fetch questions: Response Code ${data.response_code}`);
            return getFallbackQuestions(amount);

        } catch (error) {
            console.error("Network or parsing error in fetchQuestions:", error);
            return getFallbackQuestions(amount);
        }
    };

    activeFetchPromise = fetchLogic().finally(() => {
        activeFetchPromise = null;
    });

    return activeFetchPromise;
}