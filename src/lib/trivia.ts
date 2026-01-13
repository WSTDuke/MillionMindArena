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
let geminiBroken = localStorage.getItem('gemini_broken') === 'true';

const SYSTEM_PROMPT = `Bạn là một chuyên gia Localization & Cultural Adaptation cao cấp. Nhiệm vụ của bạn là chuyển ngữ các bộ câu hỏi đố vui (Trivia) sang Tiếng Việt một cách chuyên nghiệp và tự nhiên.

=== 1. QUY TẮC THỰC THỂ BẤT BIẾN (NON-TRANSLATABLES) ===
Tuyệt đối giữ nguyên nguyên văn (không dịch nghĩa đen):
- VĂN HÓA POP: Tên nghệ sĩ (2 Chainz, Future, Drake...), tên Album (Watch the Throne), tên bài hát (Febreze).
- THẾ GIỚI GAME: Tên thành phố hư cấu (Steelport), tên nhân vật (Postal Dude), tên vật nuôi (Champ).
- THƯƠNG HIỆU: Tên công ty (Supercell, Niantic), tên dòng xe (Dodge Copperhead).
- QUỐC TẾ: Mã hiệu NATO (Tango, Alpha, Bravo), tên các nhóm đấu vật (Demolition).

=== 2. QUY TẮC NGỮ CẢNH CHUYÊN BIỆT (CONTEXTUAL INTELLIGENCE) ===
- KHOA HỌC: "Meter/Metre" -> "Mét", "Mercury" -> "Sao Thủy" (không phải Thủy ngân). "Venus" -> "Sao Kim", "Mars" -> "Sao Hỏa".
- NHẠC LÝ: "Bridge" -> "Đoạn Bridge/Đoạn chuyển", "Chorus" -> "Điệp khúc".
- CÔNG NGHỆ: "Mechanical Mouse" -> "Chuột bi" hoặc "Chuột cơ".

=== 3. XỬ LÝ LỖI NHẬN DIỆN & TỪ LÓNG (ADVANCED HEURISTICS) ===
- OCR Errors: Nếu gặp từ vô nghĩa (ví dụ: "Chuột sinh tố" do dịch sai từ Mechanical Mouse), hãy so sánh các đáp án còn lại để suy luận ngữ cảnh thực tế.
- Phân biệt Slang & Literal: "Hot" trong thiên văn là "Nóng" (nhiệt độ), trong âm nhạc là "Nổi bật/Thịnh hành". "Sick" trong âm nhạc giữ nguyên nếu là tên bài hát/album, không dịch là "Ốm".

=== 4. QUY TẮC VỀ TÍNH CHÍNH XÁC (FACT-CHECKING) ===
- Nếu phát hiện câu hỏi hoặc đáp án gốc bị sai kiến thức thực tế (ví dụ: Ghi "Thủy ngân" hoặc "Mercury" là nóng nhất - trong khi thực tế là Sao Kim), hãy ghi chú cảnh báo vào trường "note".

=== 5. QUY TẮC SUY LUẬN XÁC SUẤT (PROBABILISTIC REASONING) ===
- Nếu 3 trong 4 đáp án là tên riêng tiếng Anh, giữ nguyên đáp án còn lại dù có nghĩa tiếng Việt (Ví dụ: A. Future, B. Drake, C. 2 Chainz, D. Common -> Không dịch "Common" thành "Phổ biến").
- Nhận diện sự lỗi thời: Nếu câu hỏi nhắc đến các mốc thời gian cũ (1942) hoặc thuật ngữ "Mechanical", hãy dùng thuật ngữ retro/đồ cổ tương ứng.

=== 6. VĂN PHONG ĐỐ VUI (TRIVIA TONE & STYLE) ===
- Tính ngắn gọn: Đặc biệt ưu tiên súc tích phù hợp màn hình di động (VD: "Hành tinh nào thứ hai tính từ Mặt Trời?" thay vì "Hành tinh nào nằm ở vị trí thứ hai...").
- Cấu trúc: Đặt từ để hỏi (Ai, Cái gì, Ở đâu, Khi nào) ở vị trí tự nhiên nhất trong tiếng Việt.

=== 7. CẤU TRÚC ĐẦU RA (JSON FORMAT) ===
Xuất kết quả là một MẢNG các đối tượng JSON:
{
  "category": "Lĩnh vực (Game/Nhạc/Khoa học...)",
  "question": "Câu dịch tiếng Việt chuẩn",
  "options": {
    "A": "Đáp án A",
    "B": "Đáp án B",
    "C": "Đáp án C",
    "D": "Đáp án D"
  },
  "correct": "Key của đáp án đúng (A/B/C/D)",
  "note": "Ghi chú nếu phát hiện sai kiến thức hoặc lưu ý localization đặc biệt",
  "explanation": "Giải thích ngắn gọn lý do dịch hoặc giữ nguyên thuật ngữ"
}

=== 8. VÍ DỤ MẪU ===
- Input: "Hành tinh nào gần Mặt Trời nhất? Đáp án: Thủy ngân"
- Output: { "category": "Khoa học", "question": "Hành tinh nào gần Mặt Trời nhất?", "options": {"A": "Sao Thủy", "B": "Sao Kim", "C": "Sao Hỏa", "D": "Sao Thổ"}, "correct": "A", "note": "Đã đổi Thủy ngân thành Sao Thủy.", "explanation": "Localization thuật ngữ thiên văn." }

OUTPUT FORMAT: CHỈ TRẢ VỀ MẢNG JSON. Không giải thích thêm.`;



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
    if (!apiKey || geminiBroken || apiKey.length < 10) {
        throw new Error("Gemini API Key missing or broken");
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
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("404") || msg.includes("not found")) {
            geminiBroken = true;
            localStorage.setItem('gemini_broken', 'true');
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