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
    category?: string;
    explanation?: string;
    note?: string;
}

interface RawQuestion {
    text: string;
    correct: string;
    incorrect: string[];
    category?: string;
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
let geminiBroken = false; // Reset on every reload for self-healing

const SYSTEM_PROMPT = `Bạn là một chuyên gia Localization & Cultural Adaptation cao cấp. Nhiệm vụ của bạn là chuyển ngữ các bộ câu hỏi đố vui (Trivia) sang Tiếng Việt một cách chuyên nghiệp, tự nhiên và súc tích.

=== 1. QUY TẮC KHÔNG DỊCH (DO NOT TRANSLATE) ===
Tuyệt đối giữ nguyên nguyên bản (English) cho các thực thể sau:
- TÊN NGHỆ SĨ / NHÓM NHẠC: Ví dụ: 2 Chainz, Future, Drake, Red Hot Chili Peppers, The Weeknd...
- TÊN TÁC PHẨM (Album, Bài hát, Phim): Ví dụ: Watch the Throne, Febreze, Blood Sugar Sex Magik, Star Wars...
- GAME & ĐỊA DANH TRONG GAME: Ví dụ: Saints Row, Steelport, Battlefield 1942, Vice City...
- NHÂN VẬT / THÚ CƯNG: Ví dụ: Postal Dude, Champ, Blinky, Master Chief...
- THƯƠNG HIỆU / CÔNG NGHỆ / XE: Ví dụ: Supercell, Niantic, Dodge Copperhead, iPhone...
- MÃ HIỆU / KÝ TỰ NATO: Ví dụ: Tango, Alpha, Bravo, Delta...

=== 2. CHUẨN HÓA NGỮ CẢNH (CONTEXTUAL ACCURACY) ===
Phải dịch dựa trên lĩnh vực chuyên môn của câu hỏi:
- KHOA HỌC: "Meter/Metre" -> "Mét" (đơn vị), KHÔNG dịch "Đồng hồ đo".
- THIÊN VĂN: "Mercury" -> "Sao Thủy" (hành tinh), KHÔNG dịch "Thủy ngân".
- NHẠC LÝ: "Bridge" -> "Đoạn Bridge" hoặc "Đoạn chuyển tiếp", KHÔNG dịch "Cây cầu".
- TIN HỌC: "Mechanical Mouse" -> "Chuột bi" hoặc "Chuột cơ", KHÔNG dịch "Chuột sinh tố".

=== 3. HÀNH ĐỘNG KHÔI PHỤC (AUTO-RECOVERY) ===
- Nếu phát hiện dữ liệu gốc có dấu hiệu bị dịch máy sai nghĩa đen từ trước (Ví dụ: "2 Chuỗi" thay vì "2 Chainz", "Cảng thép" thay vì "Steelport", "Xem ngai vàng" thay vì "Watch the Throne"), hãy TRUY VẾT về gốc tiếng Anh và trả về đúng tên riêng nguyên bản.

=== 4. TỪ LÓNG & NGHĨA BÓNG ===
- Phân biệt Slang & Literal: "Hot" trong thiên văn là "Nóng", trong âm nhạc là "Nổi bật/Thịnh hành".
- "Sick" trong âm nhạc/nghệ thuật nếu là tính từ miêu tả thì dùng "Đỉnh/Cực hay", nếu là tên riêng thì giữ nguyên.

=== 5. QUY TẮC SUY LUẬN XÁC SUẤT ===
- Nếu 3 trong 4 đáp án là tên riêng tiếng Anh, giữ nguyên đáp án còn lại ở dạng tiếng Anh dù nó có nghĩa từ điển (Ví dụ: A. Future, B. Drake, C. 2 Chainz, D. Common -> Trả về "Common", không dịch "Phổ biến").

=== 6. VĂN PHONG ĐỐ VUI (TONE & STYLE) ===
- CỰC KỲ NGẮN GỌN: Phải súc tích để phù hợp với giao diện di động.
- Tự nhiên: Đặt từ để hỏi (Ai, Cái gì, Ở đâu...) ở vị trí xuôi tai trong tiếng Việt.

=== 7. CẤU TRÚC ĐẦU RA (JSON FORMAT) ===
{
  "category": "Lĩnh vực",
  "question": "Câu dịch tiếng Việt",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "correct": "A/B/C/D",
  "note": "Cảnh báo sai kiến thức hoặc lưu ý localization",
  "explanation": "Lý do giữ nguyên hoặc chọn thuật ngữ"
}

OUTPUT: CHỈ TRẢ VỀ MẢNG JSON.`;



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

interface GeminiResponseItem {
    id?: number;
    category: string;
    question: string;
    options: Record<string, string>;
    correct: string;
    note?: string;
    explanation?: string;
}

/**
 * Translates a batch of RawQuestion objects using Gemini AI.
 */
async function translateBatchWithGemini(questions: RawQuestion[]): Promise<ProcessedQuestion[]> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY?.trim();
    
    if (!apiKey || apiKey.length < 10) {
        throw new Error("Gemini API Key missing (VITE_GEMINI_API_KEY). Please check your .env file.");
    }

    if (geminiBroken) {
        throw new Error("Gemini is currently disabled due to a persistent error.");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }, { apiVersion: "v1" });

        // Prepare input for Gemini
        const inputData = questions.map((q, idx) => ({
            id: idx,
            category: q.category || "General",
            question: q.text,
            correct_answer: q.correct,
            incorrect_answers: q.incorrect
        }));

        const prompt = `${SYSTEM_PROMPT}\n\nINPUT DATA TO LOCALIZE (JSON):\n${JSON.stringify(inputData)}`;
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        
        if (text.includes("```")) {
            text = text.replace(/```json|```/g, "").trim();
        }
        
        const translatedArray = JSON.parse(text) as GeminiResponseItem[];
        
        if (Array.isArray(translatedArray)) {
            return translatedArray.map((item, idx: number) => {
                const opts = item.options;
                const options = [opts.A, opts.B, opts.C, opts.D].filter(Boolean);
                const correctKey = item.correct || "A";
                const correctValue = opts[correctKey];
                const correctIndex = options.indexOf(correctValue);

                const capitalize = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

                return {
                    text: item.question || questions[idx].text,
                    options: options.map(capitalize),
                    correctAnswer: correctIndex !== -1 ? correctIndex : 0,
                    category: item.category,
                    explanation: item.explanation,
                    note: item.note
                };
            });
        }
        throw new Error("Mismatched output format");
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        
        // If it's a permanent configuration error (404, 401), disable Gemini for this session
        if (msg.includes("404") || msg.includes("not found") || msg.includes("401") || msg.includes("API_KEY_INVALID")) {
            console.error("Gemini critical error detected. Disabling Gemini for this session:", msg);
            geminiBroken = true;
        }
        throw error;
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
        
        // Global rate limit check (Persistent)
        const nowTime = Date.now();
        const storedLastRequest = parseInt(localStorage.getItem('opentdb_last_request') || '0', 10);
        
        // Sync in-memory with storage for robustness
        lastRequestTime = Math.max(lastRequestTime, storedLastRequest);
        
        const timeSinceLastRequest = nowTime - lastRequestTime;
        if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
            const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            console.warn(`Rate limit prevention (Persistent): Waiting ${waitTime}ms...`);
            await sleep(waitTime);
        }

        // Update timestamp immediately before fetch to prevent parallel tabs from racing
        const requestTime = Date.now();
        lastRequestTime = requestTime;
        localStorage.setItem('opentdb_last_request', requestTime.toString());

        try {
            const res = await fetch(url);
            
            if (res.status === 429) {
                console.warn(`OpenTDB Rate Limit Hit (429). Retries left: ${retries}`);
                if (retries > 0) {
                    // Exponential backoff with jitter: (MIN_INTERVAL * 1.5 ^ (3-retries)) + random(1-2s)
                    const backoffMultiplier = Math.pow(1.5, (3 - retries));
                    const jitter = Math.random() * 2000;
                    const waitTime = (MIN_REQUEST_INTERVAL * backoffMultiplier) + jitter;
                    
                    console.log(`OpenTDB Backoff: Waiting ${Math.round(waitTime)}ms before retry...`);
                    await sleep(waitTime);
                    
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
                        incorrect: decodedIncorrect,
                        category: q.category
                    };
                });

                // ... Translation Logic ...
                const translatedQuestions: ProcessedQuestion[] = [];
                
                try {
                    for (let i = 0; i < rawQuestions.length; i += 10) {
                        const batch = rawQuestions.slice(i, i + 10);
                        
                        try {
                            const translatedBatch = await translateBatchWithGemini(batch);
                            translatedQuestions.push(...translatedBatch);
                        } catch (geminiError) {
                            console.warn("Gemini batch failed, falling back to Google for this batch:", geminiError);
                            
                            // Google Fallback (Flat strings)
                            const stringsToTranslate: string[] = [];
                            batch.forEach((q: RawQuestion) => {
                                stringsToTranslate.push(q.text, q.correct, ...q.incorrect);
                            });
                            
                            const translatedStrings = await translateBatchWithGoogle(stringsToTranslate);
                            
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
                    }
                    return translatedQuestions;
                } catch (translateError) {
                    console.error("Critical translation failure, returning fallback questions:", translateError);
                    return getFallbackQuestions(amount);
                }

            } else if ((data.response_code === 3 || data.response_code === 4) && retries > 0) {
                // Token Not Found or Token Empty (exhausted)
                console.warn(`OpenTDB Token Error (Code ${data.response_code}). Resetting and retrying...`);
                if (userId) {
                    await supabase.from('profiles').update({ opentdb_token: null }).eq('id', userId);
                }
                return fetchQuestions(amount, difficulty, userId, retries - 1);
            } else if (data.response_code === 5 && retries > 0) {
                console.warn(`OpenTDB Response Code 5 (Rate Limit). Retrying...`);
                await sleep(MIN_REQUEST_INTERVAL + 2000);
                return fetchQuestions(amount, difficulty, userId, retries - 1);
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