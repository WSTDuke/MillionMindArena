import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Trophy, HelpCircle, Zap, Shield, LogOut, Loader2, Flag } from 'lucide-react';

import { supabase } from '../../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { fetchQuestions } from '../../lib/trivia';
import type { ProcessedQuestion } from '../../lib/trivia';

import { leaveRoom as leaveRoomUtil } from '../../lib/roomManager';
import { calculateMMRChange, getRankFromMMR } from '../../lib/ranking';
import RankBadge from '../../components/shared/RankBadge';

interface Profile {
    display_name: string;
    avatar_url: string;
    rank_name?: string;
    mmr?: number | null;
}

interface ClanMemberResult {
    id: string;
    name: string;
    avatar: string;
    isCorrect: boolean | null; // null = viewing question, true/false = answered
    score: number;
}

interface Participant {
    id: string;
    display_name: string;
    avatar_url: string;
    is_ready: boolean;
    is_host: boolean;
    rank?: string;
}

const GamePlayView = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const mode = searchParams.get('mode') || 'Normal';
    const isRanked = mode.toLowerCase() === 'ranked';
    const isBot = mode.toLowerCase() === 'bot';
    const QUESTION_TIME = isBot ? 10 : 15;

    const [profile, setProfile] = useState<Profile | null>(null);
    const [userId, setUserId] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState(QUESTION_TIME);
    const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
    const [isConfirmed, setIsConfirmed] = useState(false);
    const [modalType, setModalType] = useState<'exit' | 'surrender' | null>(null);
    const [gameStage, setGameStage] = useState<'preparing' | 'starting' | 'playing'>('preparing');
    const [introTimer, setIntroTimer] = useState(5);

    // Trivia Data States
    const [questions, setQuestions] = useState<ProcessedQuestion[]>([]);
    const [isLoadingQuestions, setIsLoadingQuestions] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // New Quiz States
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [userScore, setUserScore] = useState(0);
    const [opponentScore, setOpponentScore] = useState(0);
    const [showTransition, setShowTransition] = useState(false);
    const [roundPoints, setRoundPoints] = useState({ user: 0, opponent: 0 });
    const [isGameOver, setIsGameOver] = useState(false);

    // Cinematic & Set Scoring States
    const [setScores, setSetScores] = useState<{ user: number; opponent: number }>({ user: 0, opponent: 0 });
    const [roundPointsHistory, setRoundPointsHistory] = useState<{ user: number; opponent: number }>({ user: 0, opponent: 0 });
    const [roundScoresRecord, setRoundScoresRecord] = useState<{ user: number; opponent: number }[]>([]); // New State
    const [showRoundIntro, setShowRoundIntro] = useState(false);
    const [showSetResults, setShowSetResults] = useState(false);
    const [isMatchEnding, setIsMatchEnding] = useState(false);
    const [isNavigatingAway, setIsNavigatingAway] = useState(false);
    const [showMMRSummary, setShowMMRSummary] = useState(false);
    const [mmrChange, setMmrChange] = useState<number>(0);
    const [userNewMMR, setUserNewMMR] = useState<number | null>(null);
    const mountTimeRef = useRef(0);
    const channelRef = useRef<RealtimeChannel | null>(null);

    // Refs for real-time score tracking in timeouts
    const pointsRef = useRef({ user: 0, opponent: 0 });
    const surrenderProcessedRef = useRef(false);
    const historySavedRef = useRef(false); // Prevent duplicate history saves
    const leaveRoomRef = useRef<(() => Promise<void>) | null>(null);
    const processedQuestionRef = useRef<number>(-1);
    const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const questionsLoadedRef = useRef(false);


    const transitionStep2Ref = useRef<ReturnType<typeof setTimeout> | null>(null);
    const processedRoundRef = useRef<number>(0);
    const bufferedOpponentAnswers = useRef<Map<number, { isCorrect: boolean; points: number; currentScore?: number }>>(new Map());
    const currIndexRef = useRef<number>(0);
    const isConfirmedRef = useRef<boolean>(false);
    const winsNeededRef = useRef<number>(1);

    const roomId = searchParams.get('roomId');
    const [roomSettings, setRoomSettings] = useState<{ questions_per_round?: number; format?: string; max_rounds?: number } | null>(null);
    const [opponent, setOpponent] = useState<Participant | null>(null);
    const [opponentAnswered, setOpponentAnswered] = useState<{ isCorrect: boolean, points: number } | null>(null);

    // --- TOURNAMENT STATE ---
    const [isTournament, setIsTournament] = useState(() => {
        const s = location.state as { isTournament?: boolean } | null;
        return !!s?.isTournament;
    });
    const [showTournamentIntro, setShowTournamentIntro] = useState(() => {
        const s = location.state as { isTournament?: boolean } | null;
        return !!s?.isTournament;
    });
    const [tournamentCountdown, setTournamentCountdown] = useState(3);
    // const [clanScores, setClanScores] = useState({ myClan: 0, opponentClan: 0 }); // Removed unused
    
    // 5v5 Simulation State
    // "Me" is index 0 of myClanMembers. 4 AI teammates.
    // 5 AI opponents.
    const [myClanMembers, setMyClanMembers] = useState<ClanMemberResult[]>([]);
    const [opponentClanMembers, setOpponentClanMembers] = useState<ClanMemberResult[]>([]);
    const [myClanData, setMyClanData] = useState<{name: string, icon: string} | null>(null);
    const [oppClanData, setOppClanData] = useState<{name: string, icon: string} | null>(null);


    const questionsPerRound = roomSettings?.questions_per_round || 10;
    const matchFormat = roomSettings?.format || (isRanked ? 'Bo5' : 'Bo3');
    
    // Dynamic BoX Parsing
    const getRoundsFromFormat = (f: string) => {
        if (f.startsWith('Bo')) {
            return parseInt(f.substring(2)) || 1;
        }
        // The original logic for Bo5/Bo3 was redundant as parseInt handles it.
        // This simplified version correctly handles any BoX format.
        return 1; // Default if not BoX
    };
    
    const maxRounds = getRoundsFromFormat(matchFormat);
    const winsNeeded = Math.ceil(maxRounds / 2);

    const currentRound = Math.floor(currentQuestionIndex / questionsPerRound) + 1;
    const questionNumberInRound = (currentQuestionIndex % questionsPerRound) + 1;
    const isEndOfRound = questionNumberInRound === questionsPerRound;
    const question = questions[currentQuestionIndex];


    useEffect(() => {
        let ignore = false;

        // Redirect if state is lost (e.g., page reload)
        const locState = location.state as any;
        if (!roomId && !isBot && !locState?.isTournament) {
            navigate('/dashboard/arena');
            return;
        }

        const getData = async () => {
            try {
                // 1. Get User Session
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) {
                    if (!ignore) setIsLoadingQuestions(false);
                    return;
                }
                if (!ignore) setUserId(user.id);

                // 2. BOT MODE / TOURNAMENT MODE
                const locState = (location as any).state;
                if (locState?.isTournament) {
                    if (!ignore) {
                        setIsTournament(true);
                        setShowTournamentIntro(true);
                    }
                    const tData = locState.tournamentMatchData;
                    
                    if (!ignore) {
                        // Store clan data for icons
                        setMyClanData({
                            name: tData.clan1?.name || "MY CLAN",
                            icon: tData.clan1?.icon || "https://api.dicebear.com/7.x/shapes/svg?seed=clan1"
                        });
                        setOppClanData({
                            name: tData.clan2?.name || "OPP CLAN",
                            icon: tData.clan2?.icon || "https://api.dicebear.com/7.x/shapes/svg?seed=clan2"
                        });
                        
                        // Setup Mock Teammates & Opponents based on passed data
                        const myM = tData.members1 || [];
                        const opM = tData.members2 || [];
                        
                        const otherTeammates = myM.filter((m: any) => m.id !== user.id).slice(0, 4);
                        
                        const myTeamState: ClanMemberResult[] = otherTeammates.map((m: any) => ({
                            id: m.id,
                            name: m.name,
                            avatar: m.avatar,
                            isCorrect: null,
                            score: 0
                        }));
                        
                        setMyClanMembers(myTeamState);

                        const opTeamState: ClanMemberResult[] = opM.map((m: any) => ({
                             id: m.id,
                             name: m.name,
                             avatar: m.avatar,
                             isCorrect: null,
                             score: 0
                        }));
                        setOpponentClanMembers(opTeamState);

                        // Set Opponent Display for the 1v1 legacy slot (Optional, maybe show Clan Leader)
                        setOpponent({
                            id: 'clan-leader',
                            display_name: tData.clan2?.name || "Opponent Clan",
                            avatar_url: tData.clan2?.icon || "https://api.dicebear.com/7.x/shapes/svg?seed=opp",
                            is_ready: true,
                            is_host: false,
                            rank: 'Clan War'
                        });
                    }

                    // Fetch Profile
                    const profileRes = await supabase.from('profiles').select('*').eq('id', user.id).single();
                    if (!ignore && profileRes.data) setProfile(profileRes.data);

                    // Fetch Questions or Use Mock
                    // Fetch 30 questions for 3 rounds (10 per round)
                    const qRes = await fetchQuestions(30, 'easy', user.id); 
                    if (!ignore) {
                        setQuestions(qRes);
                        
                        // Set Room Settings for Tournament
                        setRoomSettings({
                             questions_per_round: 10,
                             format: 'Bo3' // Best of 3 Rounds
                        });
                        
                        setIsLoadingQuestions(false);
                    }
                    return;
                }

                if (isBot || roomId?.startsWith('bot-local-')) {
                    console.log('BOT mode detected: Initializing AI opponent');
                    
                    // Set BOT opponent
                    const BOT_OPPONENT: Participant = {
                        id: 'bot-ai-001',
                        display_name: 'AI Assistant',
                        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=bot-ai',
                        is_ready: true,
                        is_host: false,
                        rank: 'Diamond I'
                    };
                    if (!ignore) setOpponent(BOT_OPPONENT);

                    // Fetch profile
                    const profileRes = await supabase.from('profiles').select('*').eq('id', user.id).single();
                    if (!ignore && profileRes.data) setProfile(profileRes.data);

                    if (!ignore) {
                        setRoomSettings({
                            format: 'Bo3',
                            questions_per_round: 5
                        });


                        // Use hardcoded questions to avoid API rate limit
                        const hardcodedQuestions: ProcessedQuestion[] = Array.from({ length: 15 }, (_, i) => ({
                            text: `Câu hỏi số ${i + 1} - Đây là câu hỏi test cho chế độ BOT?`,
                            options: [
                                'Đáp án A',
                                'Đáp án B', 
                                'Đáp án C',
                                'Đáp án D'
                            ],
                            correctAnswer: Math.floor(Math.random() * 4)
                        }));
                        
                        setQuestions(hardcodedQuestions);
                        setIsLoadingQuestions(false);
                        console.log('BOT mode: Loaded 15 hardcoded questions');
                    }
                    return;
                }

                // 3. NORMAL MODE: Fetch Profile and Room Data parallelly
                const [profileRes, roomRes] = await Promise.all([
                    supabase.from('profiles').select('*').eq('id', user.id).single(),
                    roomId 
                        ? supabase.from('rooms').select('*').eq('id', roomId).single() 
                        : Promise.resolve({ data: null, error: null })
                ]);

                if (!ignore && profileRes.data) setProfile(profileRes.data);

                if (!ignore && roomRes.data) {
                    const roomData = roomRes.data;
                    if (roomData.settings) setRoomSettings(roomData.settings);

                    // Sync questions
                    if (roomData.questions && Array.isArray(roomData.questions)) {
                        setQuestions(roomData.questions);
                    } else if (isRanked) {
                        // If no questions in initial fetch, try a quick secondary fetch
                        console.warn("Retrying question fetch...");
                    }

                    // Sync opponent
                    const opp = roomData.participants?.find((p: Participant) => p.id !== user.id);
                    if (opp) setOpponent(opp);
                    
                    setIsLoadingQuestions(false);
                } else if (!ignore && !isRanked) {
                    // For solo/testing
                    const r1 = await fetchQuestions(10, 'easy', user.id);
                    setQuestions(r1);
                    setIsLoadingQuestions(false);
                } else if (!ignore) {
                     setIsLoadingQuestions(false);
                }
            } catch (error: unknown) {
                if (!ignore) {
                    console.error("Error initializing game:", error);
                    const message = error instanceof Error ? error.message : "Failed to load questions";
                    setFetchError(message);
                    setIsLoadingQuestions(false);
                }
            }
        };
        getData();

        return () => {
            ignore = true;
        };
    }, [roomId, isRanked, isBot, navigate]);

    const leaveRoom = useCallback(async () => {
        if (!roomId) return;
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await leaveRoomUtil(roomId, user.id);
        }
    }, [roomId]);

    const handleSurrender = useCallback(async () => {
        if (!userId) return;
        
        // 1. Broadcast surrender to opponent
        if (channelRef.current) {
            channelRef.current.send({
                type: 'broadcast',
                event: 'player_surrendered',
                payload: { userId }
            });
        }

        if (surrenderProcessedRef.current) return;
        surrenderProcessedRef.current = true;

        // 2. Calculate final scores (opponent wins)
        const finalScores = {
            user: setScores.user,
            opponent: setScores.opponent + 1
        };

        // 3. Save game history IMMEDIATELY for both players
        const mode = isRanked ? 'Ranked' : (isBot ? 'Bot' : ((location as any).state?.isCustom ? 'Custom' : 'Normal'));
        const userRoundScores = roundScoresRecord.map(r => r.user);
        const opponentRoundScores = roundScoresRecord.map(r => r.opponent);
        
        // Pad scores
        let maxRounds = 3;
        if (isRanked) maxRounds = 5;
        else if (roomSettings?.format?.startsWith('Bo')) {
            maxRounds = parseInt(roomSettings.format.replace('Bo', '')) || 3;
        }
        
        while (userRoundScores.length < maxRounds) userRoundScores.push(0);
        while (opponentRoundScores.length < maxRounds) opponentRoundScores.push(0);

        try {
            // Save history for current user only (surrendered = lost)
            if (!historySavedRef.current) {
                historySavedRef.current = true;
                await supabase.from('game_history').insert({
                    user_id: userId,
                    opponent_id: opponent?.id,
                    room_id: roomId,
                    result: 'Thất bại',
                    score_user: finalScores.user,
                    score_opponent: finalScores.opponent,
                    mode: mode,
                    mmr_change: 0, // No MMR change on surrender
                    round_scores: userRoundScores
                });
            }
        } catch (err) {
            console.error("Failed to save surrender history:", err);
        }

        // 4. Update UI scores
        setSetScores(finalScores);

        // 5. Trigger Game Over sequence
        setIsMatchEnding(true);
        setTimeout(() => {
            setIsGameOver(true);
            setIsMatchEnding(false);
            setModalType(null);
        }, 2000);
    }, [userId, setScores, opponent, roomId, isRanked, isBot, location, roundScoresRecord, roomSettings]);

    useEffect(() => {
        leaveRoomRef.current = leaveRoom;
    }, [leaveRoom]);

    // Keep refs in sync with state
    useEffect(() => {
        currIndexRef.current = currentQuestionIndex;
        isConfirmedRef.current = isConfirmed;
        winsNeededRef.current = winsNeeded;
        
        // Broadcast a "heartbeat" to let opponent know we are on this question
        if (channelRef.current && channelRef.current.state === 'joined') {
            channelRef.current.send({
                type: 'broadcast',
                event: 'q_sync',
                payload: { userId, qIndex: currentQuestionIndex }
            });
        }
    }, [currentQuestionIndex, userId, isConfirmed, winsNeeded]);

    // --- REALTIME SUBSCRIPTION ---
    useEffect(() => {
        // Skip Realtime for BOT mode
        if (isBot || roomId?.startsWith('bot-local-')) {
            console.log('BOT mode: Skipping Realtime subscription');
            return;
        }

        if (!roomId || !userId) return;

        let channel: RealtimeChannel | null = null;
        let retryTimeout: ReturnType<typeof setTimeout>;
        let isMounted = true;

        const cleanup = () => {
             if (channel) {
                console.log("Cleaning up Realtime channel...");
                supabase.removeChannel(channel);
                channel = null;
                channelRef.current = null;
            }
            if (retryTimeout) clearTimeout(retryTimeout);
        };

        const initializeChannel = async () => {
            if (!isMounted) return;
            
            // Clean up existing before creating new (just in case)
            if (channelRef.current) {
                await supabase.removeChannel(channelRef.current);
                channelRef.current = null;
            }

            const { data: { user } } = await supabase.auth.getUser();
            if (!user || !isMounted) return;

            const channelId = `game_${roomId}`;
            channel = supabase.channel(channelId, {
                config: {
                    broadcast: { self: false },
                    presence: { key: user.id }
                }
            });
            channelRef.current = channel;

            channel
                .on('broadcast', { event: 'player_answer' }, ({ payload }: { payload: { userId: string; qIndex: number; isCorrect: boolean; points: number; currentScore?: number } }) => {
                    const { userId: senderId, qIndex, isCorrect, points, currentScore } = payload;
                    
                    if (senderId !== user.id) {
                        console.log(`Realtime: Received answer for Q${qIndex} from opponent. Score: ${currentScore}`);
                        bufferedOpponentAnswers.current.set(qIndex, { isCorrect, points, currentScore });
                        
                        if (qIndex === currIndexRef.current) {
                            setOpponentAnswered({ isCorrect, points });
                            // DELAY UPDATE: Score will be updated in the transition phase
                        }
                    }
                })
                .on('broadcast', { event: 'q_sync' }, ({ payload }: { payload: { userId: string; qIndex: number } }) => {
                    const { userId: senderId, qIndex } = payload;
                    if (senderId !== user.id) {
                        console.log(`Realtime: Opponent is at Q${qIndex}`);
                        
                        // CATCH-UP LOGIC: If opponent is ahead and we have already answered,
                        // it means we missed their answer broadcast. Treat it as received.
                        if (qIndex > currIndexRef.current && isConfirmedRef.current) {
                            console.warn("Sync: Opponent is ahead. Forcing catch-up.");
                            const buff = bufferedOpponentAnswers.current.get(currIndexRef.current);
                            if (buff) {
                                setOpponentAnswered(buff);
                            } else {
                                // If no buffer, just show as answered to unblock transition
                                setOpponentAnswered({ isCorrect: false, points: 0 });
                            }
                        }
                    }
                })
                .on('broadcast', { event: 'player_surrendered' }, async ({ payload }: { payload: { userId: string } }) => {
                    const { userId: surrenderingId } = payload;
                    if (surrenderingId !== user.id) {
                        if (surrenderProcessedRef.current) return;
                        surrenderProcessedRef.current = true;
                        
                        console.log("Realtime: Opponent surrendered! You win.");
                        
                        // Calculate final scores (current player wins)
                        const finalScores = {
                            user: setScores.user + 1,
                            opponent: setScores.opponent
                        };

                        // Save history IMMEDIATELY for winner
                        const mode = isRanked ? 'Ranked' : (isBot ? 'Bot' : ((location as any).state?.isCustom ? 'Custom' : 'Normal'));
                        const userRoundScores = roundScoresRecord.map(r => r.user);
                        
                        // Pad scores
                        let maxRounds = 3;
                        if (isRanked) maxRounds = 5;
                        else if (roomSettings?.format?.startsWith('Bo')) {
                            maxRounds = parseInt(roomSettings.format.replace('Bo', '')) || 3;
                        }
                        
                        while (userRoundScores.length < maxRounds) userRoundScores.push(0);

                        try {
                            if (!historySavedRef.current) {
                                historySavedRef.current = true;
                                await supabase.from('game_history').insert({
                                    user_id: user.id,
                                    opponent_id: opponent?.id,
                                    room_id: roomId,
                                    result: 'Chiến thắng',
                                    score_user: finalScores.user,
                                    score_opponent: finalScores.opponent,
                                    mode: mode,
                                    mmr_change: 0, // No MMR on opponent surrender
                                    round_scores: userRoundScores
                                });
                            }
                        } catch (err) {
                            console.error("Failed to save winner history on surrender:", err);
                        }

                        // Update UI scores
                        setSetScores(finalScores);

                        // Trigger Game Over sequence
                        setIsMatchEnding(true);
                        setTimeout(() => {
                            if (isMounted) {
                                setIsGameOver(true);
                                setIsMatchEnding(false);
                            }
                        }, 2000);
                    }
                })
                .on('presence', { event: 'leave' }, ({ key }: { key: string }) => {

                     if (key !== user.id && !isGameOver && !surrenderProcessedRef.current) {
                        console.log("Opponent disconnected (Presence)! Auto-win.");
                         surrenderProcessedRef.current = true;
                         setSetScores(prev => ({
                            ...prev,
                            user: winsNeededRef.current 
                        }));
                        setIsMatchEnding(true);
                        setTimeout(() => {
                            if (isMounted) {
                                setIsGameOver(true);
                                setIsMatchEnding(false);
                            }
                        }, 2000);
                     }
                })
                .subscribe(async (status) => {
                    if (!isMounted) return;
                    
                    if (status === 'SUBSCRIBED') {
                        console.log("Realtime: WebSocket connected");
                        await channel?.track({
                             online_at: new Date().toISOString(),
                             user_id: user.id
                        });
                    } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                         console.warn(`Realtime: Subscription ${status}. Attempting reconnect...`);
                         retryTimeout = setTimeout(initializeChannel, 3000);
                    }
                });
        };

        initializeChannel();

        return () => {
            isMounted = false;
            cleanup();
        };
    }, [roomId]);

    useEffect(() => {
        mountTimeRef.current = Date.now();
        const handleBeforeUnload = () => {
            if (!isNavigatingAway && leaveRoomRef.current) {
                leaveRoomRef.current();
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        const mountTimeAtStart = mountTimeRef.current;

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            
            const duration = Date.now() - mountTimeAtStart;
            if (duration < 2000) return;

            if (!isNavigatingAway && leaveRoomRef.current) {
                leaveRoomRef.current();
            }
        };
    }, [isNavigatingAway]);

    // --- BOT AI ANSWER SIMULATION ---
    const simulateBotAnswer = useCallback((questionIndex: number) => {
        if ((!isBot && !isTournament) || !questions[questionIndex]) return;

        const delay = 2000 + Math.random() * 2000; // 2-4 seconds
        const accuracy = 0.65; 

        setTimeout(() => {
            // 1. Simulate Main Bot Opponent (for 1v1 UI compatibility)
            const isCorrect = Math.random() < accuracy;
            const points = isCorrect ? 1 : 0;

            if (isBot) {
                 setOpponentAnswered({ isCorrect, points });
                 setRoundPoints((prev) => ({ ...prev, opponent: points }));
            }

            // 2. TOURNAMENT 5v5 SIMULATION
            if (isTournament) {
                // Simulate 4 Teammates
                setMyClanMembers(prev => prev.map(m => {
                    const isTeammateCorrect = Math.random() < 0.6; // 60% chance
                    return {
                        ...m,
                        isCorrect: isTeammateCorrect,
                        score: m.score + (isTeammateCorrect ? 1 : 0)
                    };
                }));

                // Simulate 5 Opponents
                setOpponentClanMembers(prev => prev.map(m => {
                    const isOppCorrect = Math.random() < 0.6;
                    return {
                        ...m,
                        isCorrect: isOppCorrect,
                        score: m.score + (isOppCorrect ? 1 : 0)
                    };
                }));

                // Update Clan Scores
                // My Clan Score = My Points + Teammates Points
                // But wait, "My Points" are added when *I* answer. 
                // We need to decouple this. 
                // Let's add Opponents points now. 
                // My teammates points should be added when *I* answer OR when revealed.
                // For simplicity, let's reveal everyone when the "Round Transition" happens.
                
                // Store round result for batch update later?
                // Or just update state now but hidden?
                // Let's update state now, effectively "answering".
            }
            
        }, delay);
    }, [isBot, isTournament, questions]);

    const handleAnswerSelect = useCallback((index: number) => {
        if (isConfirmed || showTransition || isGameOver || !questions[currentQuestionIndex]) return;

        setIsConfirmed(true);
        setSelectedAnswer(index);

        const currentQ = questions[currentQuestionIndex];
        const uPoints = index === currentQ.correctAnswer ? 1 : 0;

        // Broadcast answer via persistent channel
        if (channelRef.current) {
            // Check if status is joined/subscribed to avoid REST fallback
            const status = channelRef.current.state;
            if (status === 'joined') {
                const newScore = userScore + uPoints;
                channelRef.current.send({
                    type: 'broadcast',
                    event: 'player_answer',
                    payload: {
                        userId: userId,
                        qIndex: currentQuestionIndex,
                        isCorrect: index === currentQ.correctAnswer,
                        points: uPoints,
                        currentScore: newScore
                    }
                });
            } else {
                console.warn("Realtime: Channel not fully joined yet (status: " + status + "). Attempting send anyway...");
                const newScore = userScore + uPoints;
                channelRef.current.send({
                    type: 'broadcast',
                    event: 'player_answer',
                    payload: {
                        userId: userId,
                        qIndex: currentQuestionIndex,
                        isCorrect: index === currentQ.correctAnswer,
                        points: uPoints,
                        currentScore: newScore
                    }
                });
            }
        }

        setRoundPoints((prev: { user: number; opponent: number }) => ({ ...prev, user: uPoints }));
        
        // BOT MODE: Trigger AI answer simulation
        if (isBot) {
            simulateBotAnswer(currentQuestionIndex);
        }
    }, [isConfirmed, showTransition, isGameOver, questions, currentQuestionIndex, userId, userScore, isBot, simulateBotAnswer]);

    // --- SYNCHRONIZED TRANSITION LOGIC ---
    useEffect(() => {
        // Check if we have a buffered answer for the current question index
        const bufferedAnswer = bufferedOpponentAnswers.current.get(currentQuestionIndex);
        if (bufferedAnswer && opponentAnswered === null) {
            console.log(`Sync: Applying buffered answer for Q${currentQuestionIndex}`);
            setOpponentAnswered(bufferedAnswer);
            // Score update is deferred to transition block
        }

        // Condition: Both have answered OR (I have answered and timer is 0)
        const bothReady = isConfirmed && (opponentAnswered !== null || timeLeft === 0);
        
        if (bothReady && !showTransition && !showSetResults && !isGameOver && !isLoadingQuestions && questions.length > 0 && processedQuestionRef.current !== currentQuestionIndex) {
            
            // Start the timer ONLY if it hasn't started yet for THIS question
            if (!transitionTimerRef.current) {
                console.log("Both players ready. Starting transition timer for index:", currentQuestionIndex);
                
                transitionTimerRef.current = setTimeout(() => {
                    // Critical: Mark as processed INSIDE the timer
                    processedQuestionRef.current = currentQuestionIndex;
                    
                    // Final update of local scores before showing transition
                    const uPoints = selectedAnswer === questions[currentQuestionIndex].correctAnswer ? 1 : 0;
                    
                    setUserScore(prev => prev + uPoints);
                    pointsRef.current.user += uPoints;
                    setRoundPointsHistory(prev => ({ ...prev, user: prev.user + uPoints }));
                    
                    // UPDATE OPPONENT SCORE (Delayed Reveal) (Code omitted for brevity, matches existing)
                    const buff = bufferedOpponentAnswers.current.get(currentQuestionIndex);
                    if (buff) {
                         if (buff.currentScore !== undefined) {
                            setOpponentScore(buff.currentScore);
                            pointsRef.current.opponent = buff.currentScore;
                            setRoundPointsHistory(prev => ({ ...prev, opponent: buff.currentScore! }));
                        } else {
                            setOpponentScore(prev => prev + buff.points);
                            pointsRef.current.opponent += buff.points;
                            setRoundPointsHistory(prev => ({ ...prev, opponent: prev.opponent + buff.points }));
                        }
                        setRoundPoints(prev => ({ ...prev, opponent: buff.points }));
                    }

                    setShowTransition(true);

                    // Hide transition and move next after 4 seconds
                    transitionStep2Ref.current = setTimeout(() => {
                        setShowTransition(false);

                        if (isEndOfRound) {
                            if (processedRoundRef.current === currentRound) return;
                            processedRoundRef.current = currentRound;

                            // SAVE ROUND SCORES TO HISTORY
                            const currentRoundScores = { ...pointsRef.current };
                            setRoundScoresRecord(prev => [...prev, currentRoundScores]);

                            const finalUserRoundPoints = pointsRef.current.user;
                            const finalOpponentRoundPoints = pointsRef.current.opponent;
                            const userWonSet = finalUserRoundPoints > finalOpponentRoundPoints;
                            const isRoundDraw = finalUserRoundPoints === finalOpponentRoundPoints;
                            
                            let newSetScores = { ...setScores };

                            if (!isRoundDraw) {
                                newSetScores = {
                                    user: userWonSet ? setScores.user + 1 : setScores.user,
                                    opponent: userWonSet ? setScores.opponent : setScores.opponent + 1
                                };
                                setSetScores(newSetScores);
                            }
                            
                            setShowSetResults(true);
                            const hasWinner = newSetScores.user >= winsNeeded || newSetScores.opponent >= winsNeeded;

                            setTimeout(() => {
                                setShowSetResults(false);
                                pointsRef.current = { user: 0, opponent: 0 };
                                setRoundPointsHistory({ user: 0, opponent: 0 });
                                setUserScore(0);
                                setOpponentScore(0);

                                if (!hasWinner && currentRound < maxRounds) {
                                    setCurrentQuestionIndex(prev => prev + 1);
                                    setOpponentAnswered(null);
                                    
                                    if (!isTournament) {
                                        setShowRoundIntro(true);
                                        setTimeout(() => setShowRoundIntro(false), 2000);
                                    }
                                    
                                    setTimeLeft(QUESTION_TIME);
                                    setIsConfirmed(false);
                                    setSelectedAnswer(null);
                                } else {
                                    setIsMatchEnding(true);
                                    setTimeout(() => {
                                        setIsGameOver(true);
                                        setIsMatchEnding(false);
                                    }, 2000);
                                }
                            }, 4000);
                        } else {
                            // Standard Next Question
                            setCurrentQuestionIndex(prev => prev + 1);
                            setOpponentAnswered(null);
                            setTimeLeft(QUESTION_TIME);
                            setIsConfirmed(false);
                            setSelectedAnswer(null);
                        }
                        
                        // Reset timer ref so next question can start its own timer
                        transitionTimerRef.current = null;
                    }, 4000);
                }, 1000);
            }
        }

        return () => {
             if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
             if (transitionStep2Ref.current) clearTimeout(transitionStep2Ref.current);
        };
    }, [isConfirmed, opponentAnswered, timeLeft, showTransition, isGameOver, isLoadingQuestions, questions, currentQuestionIndex, isEndOfRound, setScores, winsNeeded, currentRound, maxRounds, QUESTION_TIME, selectedAnswer, showSetResults]);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
        if (gameStage === 'preparing') {
            // Only start counting down once everything is loaded
            if (isLoadingQuestions || isTournament) return;

            timer = setInterval(() => {
                setIntroTimer(prev => {
                    if (prev <= 1) {
                        setGameStage('starting');
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else if (gameStage === 'starting') {
            // Snappier transition to playing state
            timer = setTimeout(() => {
                setGameStage('playing');
                // Skip round intro for tournament mode
                if (!isTournament) {
                    setShowRoundIntro(true);
                    setTimeout(() => setShowRoundIntro(false), 2000);
                }
            }, 500);
        }
        return () => {
            if (timer) {
                if (gameStage === 'preparing') clearInterval(timer as any);
                else clearTimeout(timer as any);
            }
        };
    }, [gameStage, isLoadingQuestions, isTournament]);

    useEffect(() => {
        // TIMER DECOUPLING: Timer keeps ticking even after confirmation
        // This ensures the round ALWAYS ends when time is up, regardless of sync status.
        if (timeLeft > 0 && gameStage === 'playing' && !showTransition && !isGameOver) {
            const timer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
            return () => clearInterval(timer);
        } else if (timeLeft === 0 && gameStage === 'playing' && !showTransition && !isGameOver) {
            // Timeout reached
            if (!isConfirmed) {
                // Defer to avoid cascading render lint error
                const timeoutId = setTimeout(() => {
                     handleAnswerSelect(-1);
                }, 0);
                return () => clearTimeout(timeoutId);
            }
        }
    }, [timeLeft, gameStage, showTransition, isGameOver, isConfirmed, handleAnswerSelect]);

    // Cleanup buffered answers on unmount
    useEffect(() => {
        const answersRef = bufferedOpponentAnswers.current;
        return () => {
            answersRef.clear();
        };
    }, []);


    // --- TOURNAMENT COUNTDOWN ---
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        if (showTournamentIntro && tournamentCountdown > 0) {
            timer = setTimeout(() => setTournamentCountdown(prev => prev - 1), 1000);
        } else if (showTournamentIntro && tournamentCountdown === 0) {
            // CRITICAL FIX: Wait for questions to be fully loaded before starting the game
            // This prevents the "Initializing..." screen from eating into the 15s timer
            if (isLoadingQuestions) {
                return;
            }

            timer = setTimeout(() => {
                setShowTournamentIntro(false);
                setGameStage('playing');
                // Trigger first question simulation?
            }, 1000);
        }
        return () => clearTimeout(timer);
    }, [showTournamentIntro, tournamentCountdown, isTournament, isLoadingQuestions]);

    if (fetchError || (!isLoadingQuestions && questions.length === 0)) {
        return (
            <div className="h-screen bg-neutral-950 flex flex-col items-center justify-center gap-6 p-4">
                <div className="p-6 bg-red-500/10 border border-red-500/20 rounded-3xl text-center max-w-md">
                    <HelpCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-white mb-2">Không thể tải câu hỏi</h2>
                    <p className="text-gray-400 text-sm mb-6">{fetchError || "Đã xảy ra lỗi không xác định khi tải dữ liệu trận đấu."}</p>
                    <button 
                        onClick={() => navigate('/dashboard/arena')}
                        className="w-full py-4 bg-red-600 hover:bg-red-500 text-white font-black uppercase tracking-wider rounded-2xl transition-all"
                    >
                        Quay lại Arena
                    </button>
                </div>
            </div>
        );
    }

    // FULL PAGE LOADER
    // Mask the initial data fetching for a smoother experience
    // Show this if profile is not ready, OR if in Normal/Bot mode and questions are loading
    if (!profile || (isLoadingQuestions && !isTournament)) {
        return (
            <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col items-center justify-center">
                 <div className="absolute inset-0 bg-dot-pattern opacity-10 animate-pulse"></div>
                 <div className="flex flex-col items-center gap-6 relative z-10">
                    <div className="relative">
                        <div className="w-20 h-20 border-4 border-fuchsia-600/30 border-t-fuchsia-500 rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Zap size={24} className="text-fuchsia-500 animate-pulse" />
                        </div>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                        <h2 className="text-2xl font-black text-white tracking-[0.2em] animate-pulse">LOADING</h2>
                        <p className="text-xs font-bold text-fuchsia-500 uppercase tracking-widest">System Initialization...</p>
                    </div>
                 </div>
            </div>
        );
    }
        <div className="min-h-screen bg-black text-white p-4 md:p-8 flex flex-col animate-fade-in relative overflow-y-auto font-sans selection:bg-fuchsia-500 selection:text-white overflow-x-hidden">
            {/* Background Pattern & Glows */}
            <div className="fixed inset-0 bg-dot-pattern opacity-5 pointer-events-none"></div>
            <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-blue-600/10 blur-[120px] pointer-events-none"></div>
            <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-fuchsia-600/10 blur-[120px] pointer-events-none"></div>

            {/* --- TOP HUD (Tournament Adapted) --- */}
            <div className="flex justify-between items-center mb-8 relative z-10 w-full max-w-7xl mx-auto">
                {/* Left: My Clan Team (5 Members Horizontal) */}
                {isTournament ? (
                    <div className="flex flex-col gap-3">
                        {/* Clan Info */}
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-neutral-900 border border-blue-500/30 overflow-hidden">
                                <img src={myClanData?.icon || "https://api.dicebear.com/7.x/shapes/svg?seed=clan1"} className="w-full h-full object-cover" alt="Clan Icon" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-black uppercase text-blue-400 tracking-wider">MY CLAN</span>
                                <span className="text-xs font-bold text-gray-400">Score: {userScore + myClanMembers.reduce((acc, m) => acc + m.score, 0)}</span>
                            </div>
                        </div>
                        
                        {/* 5 Team Members Row */}
                        <div className="flex items-center gap-2">
                            {/* User (Me) */}
                            <div className="relative group/member">
                                <div className={`w-12 h-12 md:w-14 md:h-14 border-2 overflow-hidden transition-all duration-300 ${
                                    isConfirmed 
                                        ? (selectedAnswer === question?.correctAnswer ? 'border-green-500 ring-2 ring-green-500/50' : 'border-red-500 ring-2 ring-red-500/50')
                                        : 'border-blue-500/50'
                                }`}
                                     style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                    <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=me"} 
                                         className="w-full h-full object-cover" alt="Me" />
                                </div>
                                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-blue-600 rounded-full flex items-center justify-center text-[9px] text-white font-black border border-white/20">
                                    {userScore}
                                </div>
                            </div>
                            
                            {/* 4 Teammates */}
                            {myClanMembers.map((m, i) => (
                                <div key={i} className="relative group/member">
                                    <div className={`w-12 h-12 md:w-14 md:h-14 border-2 overflow-hidden transition-all duration-300 ${
                                        m.isCorrect === true 
                                            ? 'border-green-500 ring-2 ring-green-500/50' 
                                            : m.isCorrect === false 
                                            ? 'border-red-500 ring-2 ring-red-500/50' 
                                            : 'border-blue-500/30'
                                    }`}
                                         style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                        <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=teammate"} 
                                             className={`w-full h-full object-cover ${m.isCorrect === null ? 'grayscale' : ''}`} alt={m.name} />
                                    </div>
                                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-neutral-900 rounded-full flex items-center justify-center text-[9px] text-white font-black border border-white/20">
                                        {m.score}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    // Standard 1v1 Layout for non-tournament
                    <div className="flex items-center gap-4 md:gap-6 group">
                        <div className="relative">
                            <div className="w-16 h-16 md:w-20 md:h-20 bg-neutral-900 border-2 border-blue-500/30 p-1 relative overflow-hidden transition-all duration-300 group-hover:border-blue-500/60"
                                 style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover" alt="Me" />
                                <div className="absolute inset-0 border border-blue-500/50 pointer-events-none mix-blend-overlay"></div>
                            </div>
                            <div className="absolute -bottom-2 -right-2 transform scale-75 md:scale-90 z-20">
                                <div className="w-8 h-8 bg-black border border-blue-500 flex items-center justify-center rotate-45 shadow-lg">
                                    <Shield size={14} className="text-blue-500 -rotate-45" />
                                </div>
                            </div>
                        </div>
                        
                        <div className="hidden md:flex flex-col">
                             <div className="flex items-center gap-2 mb-1">
                                 <span className="text-lg font-black uppercase tracking-wider text-white truncate max-w-[150px]">{profile?.display_name || "BẠN"}</span>
                                 {setScores.user > setScores.opponent && <Zap size={14} className="text-yellow-400 fill-yellow-400 animate-pulse" />}
                             </div>
                             <div className="flex flex-col gap-1.5 w-32 md:w-48">
                                 <div className="flex gap-1 h-2">
                                    {Array.from({ length: winsNeeded }).map((_, i) => (
                                        <div key={i} className={`flex-1 transform -skew-x-12 transition-all duration-500 ${i < setScores.user ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.6)]' : 'bg-white/10'}`} />
                                    ))}
                                 </div>
                                 <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-blue-400">
                                     <span>Score: {userScore}</span>
                                 </div>
                             </div>
                        </div>
                    </div>
                )}

                {/* Center: Timer */}
                <div className="absolute left-1/2 -translate-x-1/2 top-0 flex flex-col items-center z-20">
                     <div className="relative mb-4">
                        <div className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500 mb-2 text-center whitespace-nowrap">
                             Hiệp {currentRound} <span className="text-white/20 mx-2">|</span> Câu {questionNumberInRound}/{questionsPerRound}
                        </div>
                        
                        {/* Hex Timer */}
                        <div className={`relative w-20 h-20 mx-8 md:w-24 md:h-24 flex items-center justify-center transition-all duration-300 ${timeLeft <= 5 ? 'scale-110' : ''}`}>
                            {/* SVG Timer Ring */}
                            <svg className="w-full h-full -rotate-90 drop-shadow-2xl" viewBox="0 0 96 96" overflow="visible">
                                <polygon points="48,2 94,25 94,71 48,94 2,71 2,25" fill="#000" fillOpacity="0.5" stroke="#333" strokeWidth="2" />
                                <polygon 
                                    points="48,2 94,25 94,71 48,94 2,71 2,25" 
                                    fill="none" 
                                    stroke={timeLeft <= 5 ? '#ef4444' : '#d946ef'} 
                                    strokeWidth="4"
                                    strokeDasharray="308"
                                    strokeDashoffset={308 - (308 * timeLeft) / QUESTION_TIME}
                                    strokeLinecap="round"
                                    className="transition-all duration-1000 ease-linear"
                                />
                            </svg>
                            
                            {/* Number */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center pt-1">
                                <span className={`text-3xl md:text-4xl font-black tabular-nums tracking-tighter leading-none ${timeLeft <= 5 ? 'text-red-500 animate-pulse' : 'text-white'}`}>
                                    {timeLeft}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right: Opponent Clan */}
                {isTournament ? (
                    <div className="flex flex-col gap-3 items-end">
                        {/* Clan Info */}
                        <div className="flex items-center gap-2">
                            <div className="flex flex-col items-end">
                                <span className="text-sm font-black uppercase text-red-400 tracking-wider">OPP CLAN</span>
                                <span className="text-xs font-bold text-gray-400">Score: {opponentClanMembers.reduce((acc, m) => acc + m.score, 0)}</span>
                            </div>
                            <div className="w-8 h-8 bg-neutral-900 border border-red-500/30 overflow-hidden">
                                <img src={oppClanData?.icon || "https://api.dicebear.com/7.x/shapes/svg?seed=clan2"} className="w-full h-full object-cover" alt="Opp Clan Icon" />
                            </div>
                        </div>
                        
                        {/* 5 Opponent Members Row */}
                        <div className="flex items-center gap-2">
                            {opponentClanMembers.map((m, i) => (
                                <div key={i} className="relative group/member">
                                    <div className={`w-12 h-12 md:w-14 md:h-14 border-2 overflow-hidden transition-all duration-300 ${
                                        m.isCorrect === true 
                                            ? 'border-red-500 ring-2 ring-red-500/50' 
                                            : m.isCorrect === false 
                                            ? 'border-gray-600 ring-2 ring-gray-600/50' 
                                            : 'border-red-500/30'
                                    }`}
                                         style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                        <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=opponent"} 
                                             className={`w-full h-full object-cover ${m.isCorrect === null ? 'grayscale' : ''}`} alt={m.name} />
                                    </div>
                                    <div className="absolute -bottom-1 -left-1 w-4 h-4 bg-neutral-900 rounded-full flex items-center justify-center text-[9px] text-white font-black border border-white/20">
                                        {m.score}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    // Standard 1v1 Layout for non-tournament
                    <div className="flex items-center gap-4 md:gap-6 group text-right">
                        <div className="hidden md:flex flex-col items-end">
                             <div className="flex items-center gap-2 mb-1 justify-end">
                                 {setScores.opponent > setScores.user && <Zap size={14} className="text-yellow-400 fill-yellow-400 animate-pulse" />}
                                 <span className="text-lg font-black uppercase tracking-wider text-white truncate max-w-[150px]">{opponent?.display_name || "ĐỐI THỦ"}</span>
                             </div>
                             <div className="flex flex-col gap-1.5 w-32 md:w-48 items-end">
                                 <div className="flex gap-1 h-2 w-full justify-end">
                                    {Array.from({ length: winsNeeded }).map((_, i) => (
                                        <div key={i} className={`flex-1 transform skew-x-12 transition-all duration-500 ${i < setScores.opponent ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-white/10'}`} />
                                    ))}
                                 </div>
                                 <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-red-400 w-full">
                                     <span>Score: {opponentScore}</span>
                                 </div>
                             </div>
                        </div>

                        <div className="relative">
                            <div className="w-16 h-16 md:w-20 md:h-20 bg-neutral-900 border-2 border-red-500/30 p-1 relative overflow-hidden transition-all duration-300 group-hover:border-red-500/60"
                                 style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                <img 
                                    src={opponent?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${opponent?.id || 'opponent'}`} 
                                    className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" 
                                    alt="Opponent" 
                                />
                                <div className="absolute inset-0 border border-red-500/50 pointer-events-none mix-blend-overlay"></div>
                            </div>
                            <div className="absolute -bottom-2 -left-2 transform scale-75 md:scale-90 z-20">
                                <div className="w-8 h-8 bg-black border border-red-500 flex items-center justify-center rotate-45 shadow-lg">
                                    <Zap size={14} className="text-red-500 -rotate-45" />
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* --- UTILITY BUTTONS (Top Right corner absolute) --- */}
            <div className="absolute top-6 right-6 flex gap-2 z-30">
                <button 
                    onClick={() => setModalType('surrender')} 
                    className="w-10 h-10 bg-black/40 border border-white/10 hover:border-red-500/50 hover:bg-red-500/10 flex items-center justify-center transition-all backdrop-blur-sm group" 
                    style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                    title="Đầu hàng"
                >
                    <Flag size={16} className="text-gray-500 group-hover:text-red-500 transition-colors" />
                </button>
                <button 
                    onClick={() => setModalType('exit')} 
                    className="w-10 h-10 bg-black/40 border border-white/10 hover:border-white/30 hover:bg-white/10 flex items-center justify-center transition-all backdrop-blur-sm group" 
                    style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                    title="Thoát"
                >
                    <LogOut size={16} className="text-gray-500 group-hover:text-white transition-colors" />
                </button>
            </div>

            {/* --- MAIN QUESTION AREA --- */}
            <div className="flex-1 max-w-5xl mx-auto w-full flex flex-col justify-center gap-8 relative z-10 pb-8">
                
                {/* Question Card */}
                <div className="relative group">
                    <div className="absolute -inset-1 bg-gradient-to-r from-blue-600/0 via-fuchsia-500/20 to-purple-600/0 rounded-[20px] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000"></div>
                    <div className="relative bg-neutral-900/80 backdrop-blur-xl border border-white/10 p-8 md:p-12 text-center shadow-2xl"
                         style={{ clipPath: 'polygon(30px 0, 100% 0, 100% calc(100% - 30px), calc(100% - 30px) 100%, 0 100%, 0 30px)' }}>
                        {/* HUD Corners */}
                        <div className="absolute top-0 left-0 w-16 h-16 border-t-2 border-l-2 border-fuchsia-500/20"></div>
                        <div className="absolute bottom-0 right-0 w-16 h-16 border-b-2 border-r-2 border-fuchsia-500/20"></div>
                        
                        {/* Scanline */}
                        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-fuchsia-500/50 to-transparent animate-scanline-fast opacity-50"></div>

                        <div className="inline-flex items-center gap-2 mb-6 opacity-60">
                            <span className="w-2 h-2 bg-fuchsia-500 rotate-45 animate-pulse"></span>
                            <span className="text-xs font-black uppercase tracking-[0.3em] text-fuchsia-300">Câu hỏi</span>
                            <span className="w-2 h-2 bg-fuchsia-500 rotate-45 animate-pulse"></span>
                        </div>

                        <h2 className="text-2xl md:text-3xl font-black leading-tight text-white mb-2 uppercase italic tracking-wide drop-shadow-lg min-h-[4rem] flex items-center justify-center">
                            {question?.text || "Initializing data stream..."}
                        </h2>
                    </div>
                </div>

                {/* Answers Grid */}
                {gameStage === 'playing' && question ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 animate-in slide-in-from-bottom-10 duration-700 fade-in fill-mode-both">
                        {question.options.map((option: string, index: number) => {
                             const isSelected = selectedAnswer === index;
                             const isCorrect = index === question.correctAnswer;
                             const isShowCorrect = isConfirmed && isCorrect;
                             const isWrong = isConfirmed && isSelected && !isCorrect;

                             return (
                                <button
                                    key={index}
                                    onClick={() => handleAnswerSelect(index)}
                                    disabled={isConfirmed}
                                    className={`
                                        group relative p-6 h-full text-left transition-all duration-300
                                        ${isSelected 
                                            ? 'bg-fuchsia-600/20 border-fuchsia-500' 
                                            : 'bg-neutral-900/60 border-white/5 hover:border-white/20 hover:bg-neutral-800'}
                                        ${isShowCorrect ? '!bg-green-500/20 !border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : ''}
                                        ${isWrong ? '!bg-red-500/20 !border-red-500' : ''}
                                        border-l-4
                                    `}
                                    style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                >
                                    {/* Decoration */}
                                    <div className={`absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''}`}>
                                        <div className="w-6 h-6 border-t border-r border-current"></div>
                                    </div>

                                    <div className="flex items-center gap-5">
                                        <div className={`
                                            w-10 h-10 flex items-center justify-center font-black text-sm border shrink-0
                                            ${isSelected ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-black border-white/20 text-gray-500 group-hover:border-white/50 group-hover:text-white'}
                                            ${isShowCorrect ? '!bg-green-500 !border-green-500 !text-white' : ''}
                                            ${isWrong ? '!bg-red-500 !border-red-500 !text-white' : ''}
                                            transform rotate-45 transition-colors duration-300
                                        `}>
                                            <span className="-rotate-45">{String.fromCharCode(65 + index)}</span>
                                        </div>
                                        <span className={`text-lg font-bold uppercase tracking-tight ${isSelected ? 'text-white' : 'text-gray-400 group-hover:text-white'} ${isShowCorrect ? '!text-white' : ''}`}>
                                            {option}
                                        </span>
                                    </div>
                                </button>
                             );
                        })}
                    </div>
                ) : (
                    <div className="h-[300px] flex items-center justify-center">
                         <Loader2 className="w-12 h-12 text-fuchsia-500 animate-spin" />
                    </div>
                )}
            </div>

            {/* Floating Help Circle Decoration */}
            <div className="absolute overflow-hidden pointer-events-none inset-0">
                <HelpCircle size={300} className="absolute -bottom-20 -left-20 text-white/5 rotate-12" strokeWidth={0.5} />
                <Zap size={250} className="absolute top-0 -right-20 text-white/5 rotate-[-20deg]" strokeWidth={0.5} />
            </div>

            {/* Confirmation Modal */}
            {/* Confirmation Modal */}
            {modalType && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6 animate-in fade-in duration-300">
                    <div 
                        className="absolute inset-0 bg-neutral-950/90 backdrop-blur-md"
                        onClick={() => setModalType(null)}
                    ></div>
                    
                    <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 p-10 shadow-2xl animate-in zoom-in-95 duration-300 group"
                         style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                        <div className={`absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 ${modalType === 'exit' ? 'border-red-500' : 'border-fuchsia-500'}`}></div>
                        <div className={`absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 ${modalType === 'exit' ? 'border-red-500' : 'border-fuchsia-500'}`}></div>

                        <div className="flex flex-col items-center text-center">
                            <div className={`w-16 h-16 rounded-xl ${modalType === 'exit' ? 'bg-red-500/10 border-red-500/30' : 'bg-fuchsia-500/10 border-fuchsia-500/30'} border-2 flex items-center justify-center mb-6`}>
                                {modalType === 'exit' ? <LogOut size={32} className={modalType === 'exit' ? 'text-red-500' : 'text-fuchsia-500'} /> : <Flag size={32} className={modalType === 'exit' ? 'text-red-500' : 'text-fuchsia-500'} />}
                            </div>
                            
                            <h3 className="text-2xl font-black text-white mb-2 uppercase italic tracking-wide">
                                {modalType === 'exit' ? 'THOÁI TRẬN?' : 'Đầu hàng?'}
                            </h3>
                            <div className="w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent mb-6"></div>
                            
                            <p className="text-gray-400 text-sm leading-relaxed font-bold mb-8">
                                {modalType === 'exit' 
                                    ? 'Rời trận lúc này sẽ dẫn đến việc bị xử thua ngay lập tức. Hệ thống sẽ ghi nhận đây là một trận '
                                    : 'Đầu hàng sẽ kết thúc trận đấu hiện tại. Hệ thống sẽ ghi nhận đây là một trận '}
                                <span className={`${modalType === 'exit' ? 'text-red-500' : 'text-fuchsia-500'}`}>THẤT BẠI</span>.
                            </p>
                            
                            <div className="grid grid-cols-2 gap-4 w-full">
                                <button 
                                    onClick={() => setModalType(null)}
                                    className="px-6 py-4 bg-white/5 border border-white/10 text-gray-300 font-black uppercase tracking-wider hover:bg-white/10 transition-colors"
                                    style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                                >
                                    Hủy
                                </button>
                                <button 
                                    onClick={handleSurrender}
                                    className={`px-6 py-4 ${modalType === 'exit' ? 'bg-red-600 hover:bg-red-500' : 'bg-fuchsia-600 hover:bg-fuchsia-500'} text-white font-black uppercase tracking-wider shadow-lg transition-all active:scale-95`}
                                    style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                                >
                                    Xác nhận
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Match Intro Overlay */}
            {!isTournament && (gameStage === 'preparing' || gameStage === 'starting') && (
                <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-neutral-950 px-4 md:px-0">
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.1)_0%,transparent_70%)]"></div>
                        <div className="absolute inset-0 bg-dot-pattern opacity-10"></div>
                    </div>

                    <div className="relative w-full max-w-6xl flex flex-col md:flex-row items-center justify-between gap-12 md:gap-0">
                        {/* Player 1 */}
                        <div className="flex flex-col items-center gap-6 animate-in slide-in-from-left-20 duration-1000">
                             <div className="relative w-32 h-32 md:w-56 md:h-56 bg-neutral-900 border-2 border-blue-500/50 p-1 overflow-hidden"
                                  style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover" alt="Me" />
                                <div className="absolute inset-0 bg-gradient-to-t from-blue-900/50 to-transparent"></div>
                                <div className="absolute bottom-0 w-full bg-blue-600/80 p-1 text-center text-[10px] font-black uppercase tracking-[0.3em] text-white backdrop-blur-sm">YOU</div>
                             </div>
                             <div className="text-center">
                                 <h2 className="text-2xl md:text-4xl font-black text-white uppercase tracking-tighter italic">{profile?.display_name || "BẠN"}</h2>
                                 <div className="px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-bold text-blue-400 mt-2">Score: {userScore}</div>
                             </div>
                        </div>

                        {/* Center VS / Countdown */}
                        <div className="relative flex items-center justify-center w-64 h-64">
                            {gameStage === 'preparing' ? (
                                <div className="relative flex items-center justify-center w-full h-full">
                                    <div className="absolute text-[8rem] font-black italic text-white/5 tracking-tighter select-none flex items-center justify-center w-full h-full">VS</div>
                                    <svg className="absolute inset-0 w-full h-full -rotate-90 filter drop-shadow-[0_0_15px_rgba(217,70,239,0.3)]">
                                        <circle cx="50%" cy="50%" r="45%" className="stroke-white/5 fill-none" strokeWidth="2" />
                                        <circle 
                                            cx="50%" cy="50%" r="45%" 
                                            className="fill-none transition-all duration-1000 ease-linear stroke-fuchsia-500" 
                                            strokeWidth="4" 
                                            strokeDasharray="100 100"
                                            strokeDashoffset={100 - (100 * introTimer / 5)}
                                            pathLength="100"
                                        />
                                    </svg>
                                    <div key={introTimer} className="relative z-10 text-8xl font-black text-white tabular-nums animate-in zoom-in-125 fade-in duration-300 italic tracking-tighter flex items-center justify-center w-full text-center">
                                        {introTimer}
                                    </div>
                                </div>
                            ) : (
                                <div className="relative flex flex-col items-center animate-in zoom-in-150 duration-500">
                                    {isLoadingQuestions ? (
                                        <>
                                            <div className="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mb-4"></div>
                                            <div className="text-2xl font-black text-white uppercase tracking-widest animate-pulse">Waiting...</div>
                                        </>
                                    ) : (
                                        <div className="text-7xl md:text-9xl font-black uppercase tracking-tighter italic text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-400 drop-shadow-[0_0_30px_rgba(255,255,255,0.4)]">
                                            START!
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Player 2 */}
                        <div className="flex flex-col items-center gap-6 animate-in slide-in-from-right-20 duration-1000">
                             <div className="relative w-32 h-32 md:w-56 md:h-56 bg-neutral-900 border-2 border-red-500/50 p-1 overflow-hidden"
                                  style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                <img src={opponent?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${opponent?.id || 'opponent'}`} className="w-full h-full object-cover" alt="Opponent" />
                                <div className="absolute inset-0 bg-gradient-to-t from-red-900/50 to-transparent"></div>
                                <div className="absolute bottom-0 w-full bg-red-600/80 p-1 text-center text-[10px] font-black uppercase tracking-[0.3em] text-white backdrop-blur-sm">OPPONENT</div>
                             </div>
                             <div className="text-center">
                                 <h2 className="text-2xl md:text-4xl font-black text-white uppercase tracking-tighter italic">{opponent?.display_name || "ĐỐI THỦ"}</h2>
                                 <div className="px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-bold text-red-400 mt-2">Score: {opponentScore}</div>
                             </div>
                        </div>
                    </div>

                    <div className="mt-20 flex flex-col items-center gap-4">
                        <div className="px-8 py-3 bg-white/5 border border-white/10 rounded-2xl backdrop-blur-md flex items-center gap-3">
                            <p className="text-xl md:text-2xl font-black text-gray-400 uppercase tracking-[0.3em] animate-pulse">
                                {gameStage === 'preparing' ? 'ĐANG KIỂM TRA...' : 'VÀO CHƠI...'}
                            </p>
                            {isLoadingQuestions && (
                                <Loader2 size={20} className="animate-spin text-fuchsia-500" />
                            )}
                        </div>
                        <div className="flex gap-2">
                             {[1,2,3].map(i => (
                                 <div key={i} className={`w-2 h-2 rounded-full ${gameStage === 'preparing' ? 'bg-fuchsia-500 animate-pulse' : 'bg-green-500 animate-bounce'} `} style={{ animationDelay: `${i * 0.2}s` }}></div>
                             ))}
                        </div>
                    </div>
                </div>
            )}
            {/* Round Transition Overlay */}
            {showTransition && (
                <div className="fixed inset-0 z-[60] bg-neutral-950/95 backdrop-blur-xl animate-in fade-in duration-300 overflow-y-auto custom-scrollbar">
                    <div className="min-h-full flex flex-col items-center justify-center p-4 py-8">
                        <div className="absolute inset-0 bg-grid-pattern opacity-10 pointer-events-none fixed"></div>
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-0 overflow-hidden">
                             <div className="text-[20vw] font-black italic text-white/[0.02] tracking-tighter leading-none whitespace-nowrap">
                                 ROUND {currentRound}
                             </div>
                        </div>

                        <div className="relative w-full max-w-7xl flex flex-col md:flex-row items-center justify-between gap-12 md:gap-0 z-10">
                             {isTournament ? (
                                 <>
                                     {/* My Clan Team - 5 Members */}
                                     <div className="flex flex-col items-center gap-4 animate-in slide-in-from-left-20 duration-700">
                                         <div className="text-xl font-black text-blue-400 uppercase tracking-wider mb-2">{myClanData?.name || "MY CLAN"}</div>
                                         <div className="flex items-center gap-3">
                                             {/* User (Me) */}
                                             <div className="flex flex-col items-center gap-2">
                                                 <div className={`w-16 h-16 md:w-20 md:h-20 border-2 overflow-hidden ${roundPoints.user > 0 ? 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]'}`}
                                                      style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                                     <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=me"} 
                                                          className="w-full h-full object-cover" alt="Me" />
                                                 </div>
                                                 <div className={`px-2 py-0.5 text-xs font-black ${roundPoints.user > 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                     {roundPoints.user > 0 ? `+${roundPoints.user}` : roundPoints.user}
                                                 </div>
                                             </div>
                                             
                                             {/* 4 Teammates */}
                                             {myClanMembers.map((m, i) => (
                                                 <div key={i} className="flex flex-col items-center gap-2">
                                                     <div className={`w-16 h-16 md:w-20 md:h-20 border-2 overflow-hidden ${m.isCorrect === true ? 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : m.isCorrect === false ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]' : 'border-gray-600'}`}
                                                          style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                                         <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=teammate"} 
                                                              className="w-full h-full object-cover" alt={m.name} />
                                                     </div>
                                                     <div className={`px-2 py-0.5 text-xs font-black ${m.isCorrect === true ? 'text-green-500' : m.isCorrect === false ? 'text-red-500' : 'text-gray-500'}`}>
                                                         {m.isCorrect === true ? '+10' : m.isCorrect === false ? '0' : '-'}
                                                     </div>
                                                 </div>
                                             ))}
                                         </div>
                                         <div className="text-sm font-bold text-white">Total: {userScore + myClanMembers.reduce((acc, m) => acc + m.score, 0)}</div>
                                     </div>

                                     {/* Center Status */}
                                     <div className="flex flex-col items-center gap-4 text-center my-8 md:my-0">
                                         <div className="px-4 py-1 bg-white/10 rounded-full border border-white/10 text-[10px] font-black uppercase tracking-[0.3em] text-gray-400">Kết thúc câu hỏi</div>
                                         <div className="text-4xl md:text-6xl font-black text-white italic tracking-tighter uppercase">
                                             {isEndOfRound ? (
                                                 <>
                                                    <span className="text-red-500">ROUND {currentRound}</span>
                                                    <br />COMPLETE
                                                 </>
                                             ) : 'NEXT QUESTION'}
                                         </div>
                                         {isEndOfRound && currentRound < maxRounds && (
                                             <div className="mt-4 px-8 py-3 bg-red-600 text-white font-black uppercase tracking-widest shadow-[0_0_30px_rgba(239,68,68,0.4)] animate-pulse"
                                                  style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                                 Chuẩn bị round {currentRound + 1}...
                                             </div>
                                         )}
                                     </div>

                                     {/* Opponent Clan Team - 5 Members */}
                                     <div className="flex flex-col items-center gap-4 animate-in slide-in-from-right-20 duration-700">
                                         <div className="text-xl font-black text-red-400 uppercase tracking-wider mb-2">{oppClanData?.name || "OPP CLAN"}</div>
                                         <div className="flex items-center gap-3">
                                             {opponentClanMembers.map((m, i) => (
                                                 <div key={i} className="flex flex-col items-center gap-2">
                                                     <div className={`w-16 h-16 md:w-20 md:h-20 border-2 overflow-hidden ${m.isCorrect === true ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]' : m.isCorrect === false ? 'border-gray-600 shadow-[0_0_20px_rgba(107,114,128,0.3)]' : 'border-gray-600'}`}
                                                          style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                                         <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=opponent"} 
                                                              className="w-full h-full object-cover" alt={m.name} />
                                                     </div>
                                                     <div className={`px-2 py-0.5 text-xs font-black ${m.isCorrect === true ? 'text-red-500' : m.isCorrect === false ? 'text-gray-500' : 'text-gray-500'}`}>
                                                         {m.isCorrect === true ? '+10' : m.isCorrect === false ? '0' : '-'}
                                                     </div>
                                                 </div>
                                             ))}
                                         </div>
                                         <div className="text-sm font-bold text-white">Total: {opponentClanMembers.reduce((acc, m) => acc + m.score, 0)}</div>
                                     </div>
                                 </>
                             ) : (
                                 <>
                                     {/* Player 1 Stats */}
                                     <div className="flex flex-col items-center gap-4 animate-in slide-in-from-left-20 duration-700">
                                         <div className="relative">
                                              <div className={`w-32 h-32 md:w-52 md:h-52 bg-neutral-900 border-4 ${roundPoints.user > 0 ? 'border-green-500 shadow-[0_0_50px_rgba(34,197,94,0.3)]' : 'border-red-500 shadow-[0_0_50px_rgba(239,68,68,0.3)]'} overflow-hidden grayscale-[0.5]`}
                                                   style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                                  <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover" alt="Me" />
                                              </div>
                                              <div className={`absolute -top-6 -right-6 w-16 h-16 md:w-20 md:h-20 flex items-center justify-center bg-black border-2 rounded-full text-2xl md:text-3xl font-black ${roundPoints.user > 0 ? 'border-green-500 text-green-500' : 'border-red-500 text-red-500'} shadow-xl z-20`}>
                                                  {roundPoints.user > 0 ? `+${roundPoints.user}` : roundPoints.user}
                                              </div>
                                         </div>
                                         <div className="text-xl md:text-2xl font-black text-white uppercase tracking-wider">{profile?.display_name || "BẠN"}</div>
                                     </div>

                                    {/* Center Status */}
                                     <div className="flex flex-col items-center gap-4 text-center my-8 md:my-0">
                                         <div className="px-4 py-1 bg-white/10 rounded-full border border-white/10 text-[10px] font-black uppercase tracking-[0.3em] text-gray-400">Status Update</div>
                                         <div className="text-4xl md:text-6xl font-black text-white italic tracking-tighter uppercase">
                                             {isEndOfRound ? (
                                                 <>
                                                    <span className="text-red-500">ROUND {currentRound}</span>
                                                    <br />COMPLETE
                                                 </>
                                             ) : 'NEXT QUESTION'}
                                         </div>
                                         {isEndOfRound && currentRound < maxRounds && (
                                             <div className="mt-4 px-8 py-3 bg-red-600 text-white font-black uppercase tracking-widest shadow-[0_0_30px_rgba(239,68,68,0.4)] animate-pulse"
                                                  style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                                 Chuẩn bị round {currentRound + 1}...
                                             </div>
                                         )}
                                     </div>

                                     {/* Player 2 Stats */}
                                     <div className="flex flex-col items-center gap-4 animate-in slide-in-from-right-20 duration-700">
                                         <div className="relative">
                                              <div className={`w-32 h-32 md:w-52 md:h-52 bg-neutral-900 border-4 ${roundPoints.opponent > 0 ? 'border-green-500 shadow-[0_0_50px_rgba(34,197,94,0.3)]' : 'border-red-500 shadow-[0_0_50px_rgba(239,68,68,0.3)]'} overflow-hidden grayscale-[0.5]`}
                                                   style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                                  <img src={opponent?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${opponent?.id || 'opponent'}`} className="w-full h-full object-cover" alt="Opponent" />
                                              </div>
                                              <div className={`absolute -top-6 -left-6 w-16 h-16 md:w-20 md:h-20 flex items-center justify-center bg-black border-2 rounded-full text-2xl md:text-3xl font-black ${roundPoints.opponent > 0 ? 'border-green-500 text-green-500' : 'border-red-500 text-red-500'} shadow-xl z-20`}>
                                                  {roundPoints.opponent > 0 ? `+${roundPoints.opponent}` : roundPoints.opponent}
                                              </div>
                                         </div>
                                         <div className="text-xl md:text-2xl font-black text-white uppercase tracking-wider">{opponent?.display_name || "ĐỐI THỦ"}</div>
                                     </div>
                                 </>
                             )}
                        </div>
                    </div>
                </div>
            )}

            {/* Game Over / Results Overlay */}
            {isGameOver && (
                <div className="fixed inset-0 z-[70] bg-neutral-950 animate-in fade-in duration-500 overflow-y-auto custom-scrollbar">
                    <div className="absolute inset-0 z-0">
                        <div className={`absolute inset-0 ${setScores.user > setScores.opponent ? 'bg-blue-900/60' : setScores.user < setScores.opponent ? 'bg-red-900/60' : 'bg-neutral-900/60'} mix-blend-overlay fixed inset-0`}></div>
                        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-neutral-950/20 fixed inset-0"></div>
                        <div className="absolute inset-0 bg-grid-pattern opacity-20 pointer-events-none fixed inset-0"></div>
                    </div>

                    <div className="min-h-full flex flex-col items-center justify-center p-4 py-8 relative z-10 text-center">
                        <div className="relative mb-8 md:mb-12 animate-in zoom-in-50 duration-700 mt-8 md:mt-0">
                            <h1 className="text-5xl md:text-9xl font-black uppercase tracking-tighter italic leading-none text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-500 drop-shadow-2xl">
                                {setScores.user > setScores.opponent ? 'VICTORY' : setScores.user === setScores.opponent ? 'DRAW' : 'DEFEAT'}
                            </h1>
                            <div className="w-32 h-1 bg-gradient-to-r from-transparent via-white/50 to-transparent mx-auto mt-4"></div>
                        </div>

                        <div className="relative grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-16 w-full max-w-4xl mb-12 z-10">
                             {/* My Score */}
                             <div className={`relative p-6 md:p-8 border-2 ${setScores.user >= setScores.opponent ? 'bg-blue-900/40 border-blue-500/50' : 'bg-neutral-900/40 border-white/10'} backdrop-blur-xl animate-in slide-in-from-left-20 duration-1000 overflow-hidden group`}
                                  style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                 
                                 <div className="absolute -right-4 top-1/2 -translate-y-1/2 text-[8rem] md:text-9xl font-black text-white/5 italic select-none">{setScores.user}</div>
                                 
                                 <div className="relative z-10 flex flex-col items-center">
                                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl overflow-hidden border-2 border-white/20 mb-4 shadow-2xl skew-x-[-5deg]">
                                         <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover scale-110" alt="Me" />
                                     </div>
                                     <div className="text-gray-400 font-bold uppercase text-[10px] tracking-[0.3em] mb-1">Điểm số các round</div>
                                     <div className="text-4xl md:text-5xl font-black text-white tracking-tighter mb-4">{userScore}</div>
                                 </div>
                             </div>

                             {/* Opponent Score */}
                             <div className={`relative p-6 md:p-8 border-2 ${setScores.opponent > setScores.user ? 'bg-red-900/40 border-red-500/50' : 'bg-neutral-900/40 border-white/10'} backdrop-blur-xl animate-in slide-in-from-right-20 duration-1000 overflow-hidden group`}
                                  style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                 
                                 <div className="absolute -left-4 top-1/2 -translate-y-1/2 text-[8rem] md:text-9xl font-black text-white/5 italic select-none">{setScores.opponent}</div>

                                 <div className="relative z-10 flex flex-col items-center">
                                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl overflow-hidden border-2 border-white/20 mb-4 shadow-2xl skew-x-[5deg]">
                                         <img src={opponent?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${opponent?.id || 'opponent'}`} className="w-full h-full object-cover scale-110" alt="Opponent" />
                                     </div>
                                     <div className="text-gray-400 font-bold uppercase text-[10px] tracking-[0.3em] mb-1">Điểm số các round</div>
                                     <div className="text-4xl md:text-5xl font-black text-white tracking-tighter mb-4">{opponentScore}</div>
                                 </div>
                             </div>
                        </div>

                        {isRanked && showMMRSummary ? (
                            <div className="fixed inset-0 z-[120] bg-neutral-950 flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-500 overflow-hidden p-4">
                                 {/* Background Glows */}
                                 <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-fuchsia-600/10 rounded-full blur-[120px] pointer-events-none"></div>

                                 <MMRSummaryOverlay 
                                    mmr={userNewMMR} 
                                    change={mmrChange} 
                                    avatarUrl={profile?.avatar_url || undefined}
                                    onDone={async () => {
                                        setIsNavigatingAway(true);
                                        await leaveRoom();
                                        navigate('/dashboard/arena');
                                    }}
                                 />
                            </div>
                        ) : (
                            <button 
                                onClick={async () => {
                                    const isWin = setScores.user > setScores.opponent;
                                    const isDraw = setScores.user === setScores.opponent;
                                    const result = isWin ? 'Chiến thắng' : (isDraw ? 'Hòa' : 'Thất bại');

                                    let mode = 'Normal';
                                    if (isRanked) mode = 'Ranked';
                                    else if (isBot) mode = 'Bot';
                                    else if ((location as any).state?.isCustom) mode = 'Custom';

                                    const userRoundScores = roundScoresRecord.map(r => r.user);
                                    let maxRounds = 3; 
                                    if (isRanked) maxRounds = 5; 
                                    else if (roomSettings?.format?.startsWith('Bo')) {
                                        maxRounds = parseInt(roomSettings.format.replace('Bo', '')) || 3;
                                    }

                                    while (userRoundScores.length < maxRounds) {
                                        userRoundScores.push(0);
                                    }
                                    
                                    try {
                                        if (!historySavedRef.current) {
                                            historySavedRef.current = true;
                                            await supabase.from('game_history').insert({
                                                user_id: userId,
                                                opponent_id: opponent?.id,
                                                room_id: roomId,
                                                result: result,
                                                score_user: setScores.user,
                                                score_opponent: setScores.opponent,
                                                mode: mode,
                                                mmr_change: isRanked ? (mmrChange || 0) : 0,
                                                round_scores: userRoundScores
                                            });
                                        }
                                    } catch (err) {
                                        console.error("Failed to save game history:", err);
                                    }

                                    if (isRanked) {
                                        if (userId && profile) {
                                            if (!isDraw) {
                                                const currentMMR = profile.mmr ?? null;
                                                const calculatedNewMMR = calculateMMRChange(currentMMR, isWin);
                                                const change = calculatedNewMMR - (currentMMR || 0);
                                                
                                                setMmrChange(change);
                                                setUserNewMMR(calculatedNewMMR);

                                                await supabase
                                                    .from('profiles')
                                                    .update({ mmr: calculatedNewMMR })
                                                    .eq('id', userId);
                                            } else {
                                                setMmrChange(0);
                                                setUserNewMMR(profile.mmr ?? 0);
                                            }
                                        }
                                        setShowMMRSummary(true);
                                        return;
                                    }

                                    setIsNavigatingAway(true);
                                    await leaveRoom();
                                    navigate('/dashboard/arena');
                                }}
                                className="relative px-12 py-5 bg-white text-black font-black uppercase tracking-widest hover:scale-105 transition-transform active:scale-95 shadow-[0_0_50px_rgba(255,255,255,0.4)] z-[75] mb-8 md:mb-0"
                                style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                            >
                                {isRanked ? 'Continue to Rank Update' : 'Quay lại sảnh chính'}
                            </button>
                        )}
                    </div>
                </div>
            )}
            
            {/* Round Intro Overlay (Black Screen) */}
            {showRoundIntro && (
                <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center animate-in fade-in duration-700">
                    <div className="flex flex-col items-center gap-4 animate-in zoom-in-50 duration-500">
                         <div className="w-20 h-1 bg-white/20 rounded-full mb-4"></div>
                         <h1 className="text-6xl md:text-9xl font-black text-white tracking-[0.2em] italic">ROUND {currentRound}</h1>
                         <div className="w-20 h-1 bg-white/20 rounded-full mt-4"></div>
                         <p className="text-gray-500 font-bold uppercase tracking-[0.5em] animate-pulse">Bắt đầu round đấu...</p>
                    </div>
                </div>
            )}

            {/* Set Result (Face-off Style) Overlay */}
            {showSetResults && (
                <div className="fixed inset-0 z-[90] bg-neutral-950 animate-in fade-in duration-500 overflow-y-auto custom-scrollbar">
                    <div className="min-h-full flex flex-col items-center justify-center p-4 py-8 relative">
                        <div className="absolute inset-0 bg-dot-pattern opacity-10 fixed"></div>
                        <div className="absolute top-0 w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent fixed"></div>
                        <div className="absolute bottom-0 w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent fixed"></div>
                        
                        <div className="relative mb-12 text-center z-10">
                            <h2 className="text-3xl md:text-5xl font-black text-white uppercase italic tracking-tighter mb-8 animate-in slide-in-from-top-10 duration-700">ROUND {currentRound} COMPLETE</h2>
                            
                            <div className="px-12 py-6 bg-white/5 border border-white/10 backdrop-blur-xl relative" style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-[0.4em] mb-2 block">Match Score</span>
                                <div className="text-6xl md:text-8xl font-black text-white tracking-widest flex items-center justify-center gap-8">
                                    <span className={setScores.user > setScores.opponent ? 'text-blue-500' : 'text-gray-500'}>{setScores.user}</span>
                                    <div className="h-12 w-px bg-white/10 rotate-12"></div>
                                    <span className={setScores.opponent > setScores.user ? 'text-red-500' : 'text-gray-500'}>{setScores.opponent}</span>
                                </div>
                            </div>
                        </div>

                        <div className="relative w-full max-w-5xl grid grid-cols-1 md:grid-cols-2 items-center gap-12 md:gap-12 px-2 md:px-0 z-10">
                            {/* Player 1 Stats */}
                            <div className="flex flex-col items-center gap-6">
                                <div className="relative">
                                    <div className="w-24 h-24 md:w-48 md:h-48 rounded-3xl border-2 border-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.3)] bg-neutral-900 p-1 rotate-[-3deg]"
                                         style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                        <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover grayscale-[0.5]" alt="Me" />
                                    </div>
                                    <div className="absolute -top-3 -right-3 px-4 py-2 bg-blue-600 font-black text-xl italic shadow-xl z-20">
                                        +{roundPointsHistory.user}
                                    </div>
                                </div>
                                <div className="text-xl font-black text-white uppercase tracking-tighter">{profile?.display_name || "BẠN"}</div>
                            </div>

                            {/* Player 2 Stats */}
                            <div className="flex flex-col items-center gap-6">
                                <div className="relative">
                                    <div className="w-24 h-24 md:w-48 md:h-48 rounded-3xl border-2 border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)] bg-neutral-900 p-1 rotate-[3deg]"
                                         style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                        <img src={opponent?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${opponent?.id || 'opponent'}`} className="w-full h-full object-cover grayscale-[0.5]" alt="Opponent" />
                                    </div>
                                    <div className="absolute -top-3 -left-3 px-4 py-2 bg-red-600 font-black text-xl italic shadow-xl z-20">
                                        +{roundPointsHistory.opponent}
                                    </div>
                                </div>
                                <div className="text-xl font-black text-white uppercase tracking-tighter">{opponent?.display_name || "ĐỐI THỦ"}</div>
                            </div>
                            
                            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-full bg-gradient-to-b from-transparent via-white/10 to-transparent hidden md:block"></div>
                        </div>
                    </div>
                </div>
            )}

            {/* Match End Overlay (Black Screen) */}
            {isMatchEnding && (
                <div className="fixed inset-0 z-[110] bg-black flex items-center justify-center animate-in fade-in duration-700">
                    <div className="text-center animate-in zoom-in-150 duration-700">
                         <h1 className="text-6xl md:text-9xl font-black text-white uppercase tracking-widest italic leading-none mb-4">TRẬN ĐẤU<br/>KẾT THÚC</h1>
                    </div>
                </div>
            )}

            {/* --- TOURNAMENT INTRO OVERLAY --- */}
            {showTournamentIntro && (
                <div className="fixed inset-0 z-[200] bg-black flex flex-col items-center justify-center font-sans">
                     <div className="absolute inset-0 bg-neutral-900">
                         {/* Background Effects */}
                         <div className="absolute inset-0 bg-grid-pattern opacity-10"></div>
                         <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-fuchsia-900/20 to-transparent"></div>
                         <div className="absolute bottom-0 left-0 w-full h-[500px] bg-gradient-to-t from-blue-900/20 to-transparent"></div>
                     </div>

                     <div className="relative z-10 w-full max-w-7xl flex flex-col items-center gap-12">
                         {/* Header */}
                         <div className="text-center space-y-2">
                             <div className="px-6 py-2 bg-white/5 border border-white/10 rounded-full inline-flex items-center gap-2 backdrop-blur-md">
                                 <Trophy size={16} className="text-yellow-500" />
                                 <span className="text-xs font-black uppercase tracking-[0.3em] text-white">Tournament Match</span>
                             </div>
                             <h1 className="text-4xl md:text-6xl font-black text-white uppercase italic tracking-tighter">
                                 Team Battle <span className="text-fuchsia-500">5 vs 5</span>
                             </h1>
                         </div>

                         {/* VS Area */}
                         <div className="flex items-center justify-center gap-12 md:gap-24 w-full">
                             {/* My Team - 5 Members Horizontal */}
                             <div className="flex flex-col items-center gap-6 animate-in slide-in-from-left-20 duration-700">
                                 <div className="text-2xl font-black text-blue-400 uppercase tracking-wider">MY CLAN</div>
                                 <div className="flex items-center gap-3">
                                     {/* User (Me) */}
                                     <div className="relative">
                                         <div className="w-16 h-16 md:w-20 md:h-20 border-2 border-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.3)] overflow-hidden"
                                              style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                             <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=me"} 
                                                  className="w-full h-full object-cover" alt="Me" />
                                         </div>
                                         <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-blue-600 text-white text-[10px] font-black uppercase whitespace-nowrap">
                                             YOU
                                         </div>
                                     </div>
                                     
                                     {/* 4 Teammates */}
                                     {myClanMembers.slice(0, 4).map((m, i) => (
                                         <div key={i} className="relative">
                                             <div className="w-16 h-16 md:w-20 md:h-20 border-2 border-blue-500/50 overflow-hidden"
                                                  style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                                 <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=teammate"} 
                                                      className="w-full h-full object-cover" alt={m.name} />
                                             </div>
                                         </div>
                                     ))}
                                 </div>
                             </div>

                             {/* Countdown */}
                             <div className="w-40 h-40 flex items-center justify-center relative">
                                 {tournamentCountdown > 0 ? (
                                     <span className="text-9xl font-black text-white italic tracking-tighter animate-ping duration-1000 absolute">
                                         {tournamentCountdown}
                                     </span>
                                 ) : (
                                     <span className="text-6xl font-black text-fuchsia-500 italic tracking-tighter animate-ping">
                                         FIGHT!
                                     </span>
                                 )}
                             </div>

                             {/* Opponent Team - 5 Members Horizontal */}
                             <div className="flex flex-col items-center gap-6 animate-in slide-in-from-right-20 duration-700">
                                 <div className="text-2xl font-black text-red-400 uppercase tracking-wider">OPP CLAN</div>
                                 <div className="flex items-center gap-3">
                                     {opponentClanMembers.slice(0, 5).map((m, i) => (
                                         <div key={i} className="relative">
                                             <div className="w-16 h-16 md:w-20 md:h-20 border-2 border-red-500/50 overflow-hidden"
                                                  style={{ clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)' }}>
                                                 <img src={m.avatar || "https://api.dicebear.com/7.x/avataaars/svg?seed=opponent"} 
                                                      className="w-full h-full object-cover" alt={m.name} />
                                             </div>
                                         </div>
                                     ))}
                                 </div>
                             </div>
                         </div>
                     </div>
                </div>
            )}

        </div>
    );
};

const MMRSummaryOverlay = ({ mmr, change, onDone, avatarUrl }: { mmr: number | null, change: number, onDone: () => void, avatarUrl?: string }) => {
    const rank = getRankFromMMR(mmr);
    
    return (
        <div className="relative flex flex-col items-center text-center max-w-4xl w-full px-4 z-10 animate-in fade-in slide-in-from-bottom-10 duration-700 h-full max-h-screen overflow-y-auto py-8 no-scrollbar">
            <h2 className="text-[10px] md:text-sm font-black text-gray-500 uppercase tracking-[0.5em] mb-8 shrink-0 flex items-center gap-4">
                <div className="h-px w-8 bg-gray-500/30"></div>
                RANK PERFORMANCE
                <div className="h-px w-8 bg-gray-500/30"></div>
            </h2>
            
            <div className="flex flex-col items-center justify-center w-full mb-8 shrink-0">
                {/* Rank Circle Column */}
                <div className="flex flex-col items-center">
                    <div className="relative mb-6">
                        <div className="absolute inset-0 bg-red-500/20 blur-2xl rounded-full animate-pulse"></div>
                        <RankBadge mmr={mmr} size="xl" />
                        
                        {change !== 0 && (
                            <div className={`absolute top-0 -right-8 px-4 py-2 font-black text-xl shadow-2xl animate-in slide-in-from-left-4 duration-500 delay-700 fill-mode-both flex items-center gap-1 ${
                                change > 0 ? 'bg-green-500 text-black' : 'bg-red-500 text-white'
                            }`} style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                {change > 0 ? `+${change}` : change}
                            </div>
                        )}
                    </div>

                    <h3 className="text-4xl md:text-6xl font-black text-white uppercase italic tracking-tighter mb-4 drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]">
                        {rank.tier} <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-500">{rank.division}</span>
                    </h3>
                    
                    <div className="bg-neutral-900 border border-white/10 px-6 py-2 relative overflow-hidden group" style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-2xl font-black text-white italic tracking-tighter flex items-baseline gap-2">
                            {mmr} <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">MMR POINTS</span>
                        </span>
                    </div>
                </div>
            </div>

            {/* Bottom Section: Progress Bar and Avatar Button in a row */}
            <div className="flex flex-col md:flex-row items-center justify-center gap-8 w-full max-w-5xl bg-neutral-900/60 border border-white/5 p-8 backdrop-blur-xl shrink-0" 
                 style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                
                {/* Progress Bar Side */}
                <div className="flex-1 w-full space-y-4">
                    <div className="flex justify-between items-end">
                        <span className="text-xs font-black uppercase tracking-[0.2em] text-blue-400">Progression</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">{rank.nextMMR && (rank.nextMMR - (mmr || 0))} MMR TO PROMOTION</span>
                    </div>
                    
                    <div className="h-4 w-full bg-black/50 border border-white/10 p-[2px] skew-x-[-10deg]">
                        <div 
                            className="h-full bg-gradient-to-r from-blue-600 via-fuchsia-500 to-white rounded-[1px] transition-all duration-[2s] delay-500 ease-out shadow-[0_0_15px_rgba(37,99,235,0.4)] relative overflow-hidden" 
                            style={{ width: `${rank.progress}%` }}
                        >
                            <div className="absolute inset-0 w-full h-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)] animate-[shimmer_2s_infinite]"></div>
                        </div>
                    </div>
                    
                    <p className="text-[10px] text-gray-600 uppercase font-bold tracking-widest text-left">Completing matches increases your rank rating.</p>
                </div>

                {/* Vertical Divider for desktop */}
                <div className="hidden md:block w-px h-24 bg-gradient-to-b from-transparent via-white/10 to-transparent"></div>

                {/* Avatar Exit Button */}
                <div className="flex flex-col items-center gap-4">
                    <button 
                        onClick={onDone}
                        className="group relative w-24 h-24 shrink-0 p-1 bg-neutral-800 transition-all duration-300 hover:scale-105 active:scale-95"
                        style={{ clipPath: 'polygon(20% 0, 80% 0, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0 80%, 0 20%)' }}
                    >
                        <div className="w-full h-full relative overflow-hidden" style={{ clipPath: 'polygon(20% 0, 80% 0, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0 80%, 0 20%)' }}>
                            <img 
                                src={avatarUrl || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} 
                                className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 grayscale group-hover:grayscale-0" 
                                alt="Exit" 
                            />
                            <div className="absolute inset-0 bg-fuchsia-600/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center">
                                <LogOut size={24} className="text-white mb-1" />
                                <div className="text-[8px] font-black text-white uppercase tracking-widest">EXIT</div>
                            </div>
                        </div>
                    </button>
                    <div className="flex items-center gap-2">
                        <div className="w-1 h-1 bg-fuchsia-500 rounded-full animate-ping"></div>
                        <p className="text-[9px] font-black text-gray-500 uppercase tracking-[0.2em]">CLICK TO LEAVE</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default GamePlayView;
