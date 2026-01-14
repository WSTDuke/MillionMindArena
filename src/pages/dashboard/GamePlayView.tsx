import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Trophy, HelpCircle, Zap, Shield, LogOut, Loader2, Flag, Crown, Target, Users } from 'lucide-react';

import { supabase } from '../../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { fetchQuestions } from '../../lib/trivia';
import type { ProcessedQuestion } from '../../lib/trivia';

import { leaveRoom as leaveRoomUtil } from '../../lib/roomManager';
import { calculateMMRChange, getRankFromMMR } from '../../lib/ranking';
import RankBadge from '../../components/shared/RankBadge';
import { CLAN_ICONS } from './clanConstants';

interface TournamentMatchData {
    clan1?: { name: string; icon: string; color: string };
    clan2?: { name: string; icon: string; color: string };
    members1?: { id: string; name: string; avatar: string }[];
    members2?: { id: string; name: string; avatar: string }[];
}

interface GameLocationState {
    isTournament?: boolean;
    tournamentMatchData?: TournamentMatchData;
    isBot?: boolean;
    isCustom?: boolean;
}

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
    const [resultsStep, setResultsStep] = useState<1 | 2>(1);
    const mountTimeRef = useRef(0);
    const channelRef = useRef<RealtimeChannel | null>(null);

    // Refs for real-time score tracking in timeouts
    const pointsRef = useRef({ user: 0, opponent: 0 });
    const surrenderProcessedRef = useRef(false);
    const historySavedRef = useRef(false); // Prevent duplicate history saves
    const leaveRoomRef = useRef<(() => Promise<void>) | null>(null);
    const processedQuestionRef = useRef<number>(-1);
    const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


    const processedRoundRef = useRef<number>(-1);
    const questionEndTimeRef = useRef<number | null>(null);
    const bufferedOpponentAnswers = useRef<Map<number, { isCorrect: boolean; points: number; currentScore?: number }>>(new Map());
    const currIndexRef = useRef<number>(0);
    const tournamentPointsRef = useRef<{ teammates: number, opponents: number }>({ teammates: 0, opponents: 0 });
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
    const [tournamentCountdown, setTournamentCountdown] = useState(5);
    // const [clanScores, setClanScores] = useState({ myClan: 0, opponentClan: 0 }); // Removed unused
    
    // 5v5 Simulation State
    // "Me" is index 0 of myClanMembers. 4 AI teammates.
    // 5 AI opponents.
    const [myClanMembers, setMyClanMembers] = useState<ClanMemberResult[]>([]);
    const [opponentClanMembers, setOpponentClanMembers] = useState<ClanMemberResult[]>([]);
    const [myClanData, setMyClanData] = useState<{name: string, icon: string, color: string} | null>(null);
    const [oppClanData, setOppClanData] = useState<{name: string, icon: string, color: string} | null>(null);


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

    // Calculate MVP for tournament
    const getMVP = useCallback(() => {
        const all = [...myClanMembers, ...opponentClanMembers];
        // Add current user to the list for comparison
        all.push({ id: userId || 'me', name: profile?.display_name || 'BẠN', avatar: profile?.avatar_url || '', score: userScore, isCorrect: null });
        return all.reduce((prev, current) => (prev.score > current.score) ? prev : current, all[0]);
    }, [myClanMembers, opponentClanMembers, userId, profile, userScore]);
    const mvp = isTournament ? getMVP() : null;

    const currentRound = Math.floor(currentQuestionIndex / questionsPerRound) + 1;
    const questionNumberInRound = (currentQuestionIndex % questionsPerRound) + 1;
    const isEndOfRound = questionNumberInRound === questionsPerRound;
    const question = questions[currentQuestionIndex];

    // --- RENDER HELPERS ---
    const ClanIcon = ({ iconName, color, className = "w-6 h-6" }: { iconName: string, color: string, className?: string }) => {
        const iconObj = CLAN_ICONS.find(item => item.id === iconName);
        const IconComponent = iconObj ? iconObj.icon : Shield;
        return <IconComponent className={className} style={{ color }} />;
    };


    useEffect(() => {
        let ignore = false;

        // Redirect if state is lost (e.g., page reload)
        const locState = location.state as GameLocationState;
        if (!roomId && !isBot && !locState?.isTournament) {
            navigate('/dashboard/arena');
            return;
        }

        setResultsStep(1);

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
                const locState = location.state as GameLocationState;
                if (locState?.isTournament) {
                    if (!ignore) {
                        setIsTournament(true);
                        setShowTournamentIntro(true);
                    }
                    const tData = locState.tournamentMatchData;
                    if (!tData) return;
                    
                    if (!ignore) {
                        // Store clan data for icons
                        setMyClanData({
                            name: tData.clan1?.name || "CLAN CỦA BẠN",
                            icon: tData.clan1?.icon || "Shield",
                            color: tData.clan1?.color || "#3b82f6"
                        });
                        setOppClanData({
                            name: tData.clan2?.name || "CLAN ĐỐI THỦ",
                            icon: tData.clan2?.icon || "Swords",
                            color: tData.clan2?.color || "#ef4444"
                        });
                        
                        // Setup Mock Teammates & Opponents based on passed data
                        const myM = tData.members1 || [];
                        const opM = tData.members2 || [];
                        
                        const otherTeammates = myM.filter((m: {id: string}) => m.id !== user.id).slice(0, 4);
                        
                        const myTeamState: ClanMemberResult[] = otherTeammates.map((m: {id: string, name: string, avatar: string}) => ({
                            id: m.id,
                            name: m.name,
                            avatar: m.avatar,
                            isCorrect: null,
                            score: 0
                        }));
                        
                        setMyClanMembers(myTeamState);

                        const opTeamState: ClanMemberResult[] = opM.map((m: {id: string, name: string, avatar: string}) => ({
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
    }, [roomId, isRanked, isBot, navigate, location.state]);

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
        const mode = isRanked ? 'Ranked' : (isBot ? 'Bot' : ((location.state as { isCustom?: boolean })?.isCustom ? 'Custom' : 'Normal'));
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
                        const mode = isRanked ? 'Ranked' : (isBot ? 'Bot' : ((location.state as GameLocationState)?.isCustom ? 'Custom' : 'Normal'));
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
    }, [roomId, userId, isBot, isGameOver, isRanked, location.state, opponent?.id, roomSettings?.format, roundScoresRecord, setScores.opponent, setScores.user]);

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
    const simulateBotAnswer = useCallback((questionIndex: number, forceImmediate: boolean = false) => {
        if ((!isBot && !isTournament) || !questions[questionIndex]) return;

        const delay = forceImmediate ? 0 : (2000 + Math.random() * 2000); // Bypass delay on timeout
        const accuracy = 0.65; 

        const executeSimulation = () => {
            // 1. Simulate Main Bot Opponent (for 1v1 UI compatibility)
            const isCorrect = Math.random() < accuracy;
            const points = isCorrect ? 1 : 0;

            if (isBot) {
                 setOpponentAnswered({ isCorrect, points });
                 setRoundPoints((prev) => ({ ...prev, opponent: points }));
            }

            // 2. TOURNAMENT 5v5 SIMULATION
            if (isTournament) {
                let teammatesCorrectCount = 0;
                let opponentsCorrectCount = 0;

                // Simulate 4 Teammates
                setMyClanMembers(prev => prev.map(m => {
                    const isTeammateCorrect = Math.random() < 0.6; // 60% chance
                    if (isTeammateCorrect) teammatesCorrectCount++;
                    return {
                        ...m,
                        isCorrect: isTeammateCorrect,
                        score: m.score + (isTeammateCorrect ? 1 : 0)
                    };
                }));

                // Simulate 5 Opponents
                setOpponentClanMembers(prev => prev.map(m => {
                    const isOppCorrect = Math.random() < 0.6;
                    if (isOppCorrect) opponentsCorrectCount++;
                    return {
                        ...m,
                        isCorrect: isOppCorrect,
                        score: m.score + (isOppCorrect ? 1 : 0)
                    };
                }));

                tournamentPointsRef.current = {
                    teammates: teammatesCorrectCount,
                    opponents: opponentsCorrectCount
                };

                // FIX: Always set opponentAnswered in tournament mode to unblock the legacy transition logic
                // This allows the game to progress as soon as the bots "finish" their simulation delay.
                const isOpponentCorrect = Math.random() < 0.6;
                setOpponentAnswered({ 
                    isCorrect: isOpponentCorrect, 
                    points: isOpponentCorrect ? 1 : 0 
                });
            }
        };

        if (delay === 0) {
            executeSimulation();
        } else {
            setTimeout(executeSimulation, delay);
        }
    }, [isBot, isTournament, questions]);

    const handleAnswerSelect = useCallback((index: number) => {
        if (isConfirmed || showTransition || isGameOver || !questions[currentQuestionIndex]) return;

        setIsConfirmed(true);
        setSelectedAnswer(index);

        const currentQ = questions[currentQuestionIndex];
        const uPoints = index === currentQ.correctAnswer ? 10 : 0;

        // Broadcast answer via persistent channel
        if (channelRef.current) {
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

        setRoundPoints((prev: { user: number; opponent: number }) => ({ ...prev, user: uPoints }));
        
        // BOT/TOURNAMENT: Trigger AI answer simulation
        if (isBot || isTournament) {
            simulateBotAnswer(currentQuestionIndex, index === -1);
        }
    }, [isConfirmed, showTransition, isGameOver, questions, currentQuestionIndex, userId, userScore, isBot, isTournament, simulateBotAnswer]);

    useEffect(() => {
        const bufferedAnswer = bufferedOpponentAnswers.current.get(currentQuestionIndex);
        if (bufferedAnswer && opponentAnswered === null) {
            console.log(`Sync: Applying buffered answer for Q${currentQuestionIndex}`);
            setOpponentAnswered(bufferedAnswer);
            // Score update is deferred to transition block
        }

        // Condition: Everyone has answered OR timer hit zero
        const allParticipantsAnswered = isTournament 
            ? (isConfirmed && myClanMembers.every(m => m.isCorrect !== null) && opponentClanMembers.every(m => m.isCorrect !== null))
            : (isConfirmed && opponentAnswered !== null);

        const bothReady = allParticipantsAnswered || timeLeft === 0;
        
        // --- STEP 1: TRIGGER TRANSITION ---
        if (bothReady && !showTransition && !showSetResults && !isGameOver && !isLoadingQuestions && questions.length > 0 && processedQuestionRef.current !== currentQuestionIndex) {
            
            if (!transitionTimerRef.current) {
                console.log("Starting transition reveal timer for index:", currentQuestionIndex);
                
                // Mark as processed immediately to prevent duplicate timers if re-renders occur
                processedQuestionRef.current = currentQuestionIndex;

                transitionTimerRef.current = setTimeout(() => {
                    // Final update of local scores before showing transition
                    const uPoints = (selectedAnswer === questions[currentQuestionIndex]?.correctAnswer) ? 10 : 0;
                    const roundPointsAdded = uPoints + (isTournament ? tournamentPointsRef.current.teammates * 10 : 0);
                    setUserScore(prev => prev + roundPointsAdded);
                    if (pointsRef.current) pointsRef.current.user += roundPointsAdded;
                    setRoundPointsHistory(prev => ({ ...prev, user: prev.user + roundPointsAdded }));
                    
                    // UPDATE OPPONENT SCORE (Delayed Reveal)
                    const buff = bufferedOpponentAnswers.current.get(currentQuestionIndex);
                    if (buff) {
                        const oppPointsTotal = isTournament ? (tournamentPointsRef.current.opponents * 10) : (buff.points * 10);
                        
                        setOpponentScore(prev => prev + oppPointsTotal);
                        if (pointsRef.current) pointsRef.current.opponent += oppPointsTotal;
                        setRoundPointsHistory(prev => ({ ...prev, opponent: prev.opponent + oppPointsTotal }));
                        
                        setRoundPoints(prev => ({ ...prev, opponent: buff.points }));
                    }

                    setShowTransition(true);
                    
                    transitionTimerRef.current = null;
                }, 800); // Shorter delay for snappier feel
            }
        }

        return () => {
             // Only clear timer if we are actually moving to a DIFFERENT question
             // This prevents the 0-second re-renders from killing the reveal transition.
             if (transitionTimerRef.current && processedQuestionRef.current !== currentQuestionIndex) {
                 clearTimeout(transitionTimerRef.current);
                 transitionTimerRef.current = null;
             }
        };
    }, [isConfirmed, opponentAnswered, timeLeft, showTransition, isGameOver, isLoadingQuestions, questions, currentQuestionIndex, selectedAnswer, showSetResults, isTournament, myClanMembers, opponentClanMembers]);


    // SHARED LOGIC: Progress the match after a round ends
    const advanceMatch = useCallback((latestSetScores: { user: number; opponent: number }) => {
        const hasWinner = latestSetScores.user >= winsNeeded || latestSetScores.opponent >= winsNeeded;
        
        pointsRef.current = { user: 0, opponent: 0 };
        setRoundPointsHistory({ user: 0, opponent: 0 });
        setUserScore(0);
        setOpponentScore(0);

        if (!hasWinner && currentRound < maxRounds) {
            setCurrentQuestionIndex(prev => prev + 1);
            setOpponentAnswered(null);
            setMyClanMembers(prev => prev.map(m => ({ ...m, isCorrect: null })));
            setOpponentClanMembers(prev => prev.map(m => ({ ...m, isCorrect: null })));
            
            // Trigger "HIỆP X" black screen intro
            setShowRoundIntro(true);
            setTimeout(() => setShowRoundIntro(false), 2000);
            
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
    }, [winsNeeded, currentRound, maxRounds, QUESTION_TIME]);

    // --- STEP 2: HANDLE QUESTION TRANSITION ---
    useEffect(() => {
        if (showTransition) {
            console.log("Question transition active. Scheduling next step...");
                const timer = setTimeout(() => {
                    setShowTransition(false);
                    
                    if (isEndOfRound) {
                        // --- ROUND COMPLETION LOGIC ---
                        if (processedRoundRef.current !== currentRound) {
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
                            
                            // TOURNAMENT SKIP: Go directly to next round/end if tournament
                            if (isTournament) {
                                console.log("Tournament mode detected. Skipping round results overlay.");
                                advanceMatch(newSetScores);
                            } else {
                                setShowSetResults(true);
                            }
                        }
                    } else {
                        // Standard Next Question
                        setCurrentQuestionIndex(prev => prev + 1);
                        setOpponentAnswered(null);
                        setMyClanMembers(prev => prev.map(m => ({ ...m, isCorrect: null })));
                        setOpponentClanMembers(prev => prev.map(m => ({ ...m, isCorrect: null })));
                        setTimeLeft(QUESTION_TIME);
                        setIsConfirmed(false);
                        setSelectedAnswer(null);
                    }
                }, 2500); // Reduced from 4000ms to 2500ms

            return () => clearTimeout(timer);
        }
    }, [showTransition, isEndOfRound, currentRound, QUESTION_TIME, setScores, winsNeeded, isTournament, advanceMatch]);



    // --- STEP 3: HANDLE ROUND/SET RESULTS SEQUENCE ---
    useEffect(() => {
        if (showSetResults) {
            console.log("Round results active. Scheduling match progression...");
            const timer = setTimeout(() => {
                setShowSetResults(false);
                advanceMatch(setScores);
            }, 5000); // 5s for results screen

            return () => clearTimeout(timer);
        }
    }, [showSetResults, currentRound, maxRounds, isTournament, setScores, winsNeeded, QUESTION_TIME, advanceMatch]);

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
                // Show "HIỆP 1" black screen before starting
                setShowRoundIntro(true);
                setTimeout(() => {
                    setShowRoundIntro(false);
                    setGameStage('playing');
                }, 2000);
            }, 500);
        }
        return () => {
            if (timer) {
                if (gameStage === 'preparing') clearInterval(timer as unknown as number);
                else clearTimeout(timer as unknown as number);
            }
        };
    }, [gameStage, isLoadingQuestions, isTournament]);

    useEffect(() => {
        // TIMER REFACTOR: Use absolute timestamps to prevent freeze on tab blur
        if (gameStage === 'playing' && !showTransition && !isGameOver && !showRoundIntro) {
            if (!questionEndTimeRef.current) {
                questionEndTimeRef.current = Date.now() + (timeLeft * 1000);
            }

            const timer = setInterval(() => {
                const now = Date.now();
                const remaining = Math.max(0, Math.ceil((questionEndTimeRef.current! - now) / 1000));
                
                if (remaining !== timeLeft) {
                    setTimeLeft(remaining);
                }

                if (remaining === 0) {
                    clearInterval(timer);
                    // Force timeout if not confirmed
                    if (!isConfirmedRef.current && !showTransition) {
                        console.log("Timer hit 0: Forcing timeout selection.");
                        handleAnswerSelect(-1);
                    }
                }
            }, 200); // Check every 200ms
            
            return () => clearInterval(timer);
        } else {
            // Reset end time when not in playing state
            questionEndTimeRef.current = null;
        }

        // (Logical timeout check moved to interval for precision)
    }, [timeLeft, gameStage, showTransition, isGameOver, isConfirmed, handleAnswerSelect, showRoundIntro, currentQuestionIndex]);

    // Cleanup buffered answers on unmount
    useEffect(() => {
        const answersRef = bufferedOpponentAnswers.current;
        return () => {
            answersRef.clear();
        };
    }, []);


    // --- TOURNAMENT COUNTDOWN (Refactored) ---
    const isCountdownZero = tournamentCountdown === 0;
    useEffect(() => {
        if (isTournament && showTournamentIntro && !isCountdownZero) {
            const timer = setInterval(() => {
                setTournamentCountdown(prev => {
                    if (prev <= 1) {
                        clearInterval(timer);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
            return () => clearInterval(timer);
        } else if (isCountdownZero && showTournamentIntro) {
            // 4. Handle "START" / "FIGHT" Transition
            // Keep "START" on screen for 0.5 seconds, then switch to "HIỆP 1"
            const transitionTimer = setTimeout(() => {
                setShowTournamentIntro(false);
                setShowRoundIntro(true);
                setTimeout(() => {
                    setShowRoundIntro(false);
                    setGameStage('playing');
                }, 2000);
            }, 500);
            
            return () => clearTimeout(transitionTimer);
        }
    }, [isLoadingQuestions, showTournamentIntro, isTournament, isCountdownZero, tournamentCountdown]);

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
    // Show this if profile is not ready, OR if questions are still loading (for ALL modes)
    // This ensures countdown never starts until data is ready.
    if (!profile || isLoadingQuestions) {
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
                        <h2 className="text-2xl font-black text-white tracking-[0.2em] animate-pulse">CHUẨN BỊ THI ĐẤU</h2>
                        <p className="text-xs font-bold text-fuchsia-500 uppercase tracking-widest">ĐANG LẤY CÂU HỎI...</p>
                    </div>
                 </div>
            </div>
        );
    }
    
    return (
        <div className="min-h-screen bg-black text-white p-4 md:p-8 flex flex-col animate-fade-in relative overflow-y-auto overflow-x-hidden font-sans selection:bg-fuchsia-500 selection:text-white">
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
                            <div className="w-8 h-8 bg-neutral-900 border border-blue-500/30 overflow-hidden flex items-center justify-center">
                                {myClanData && <ClanIcon iconName={myClanData.icon} color={myClanData.color} className="w-5 h-5" />}
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-black uppercase text-blue-400 tracking-wider">{myClanData?.name || "CLAN CỦA BẠN"}</span>
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
                                        : 'border-zinc-700'
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
                                            : 'border-zinc-700'
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
                                <span className="text-sm font-black uppercase text-red-400 tracking-wider">{oppClanData?.name || "CLAN ĐỐI THỦ"}</span>
                                <span className="text-xs font-bold text-gray-400">Score: {opponentClanMembers.reduce((acc, m) => acc + m.score, 0)}</span>
                            </div>
                            <div className="w-8 h-8 bg-neutral-900 border border-red-500/30 overflow-hidden flex items-center justify-center">
                                {oppClanData && <ClanIcon iconName={oppClanData.icon} color={oppClanData.color} className="w-5 h-5" />}
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
                                            ? 'border-fuchsia-100 ring-2 ring-fuchsia-100/50' 
                                            : 'border-zinc-700'
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
                            <span className="text-xs font-black uppercase tracking-[0.3em] text-fuchsia-300">Câu hỏi {questionNumberInRound}</span>
                            <span className="w-2 h-2 bg-fuchsia-500 rotate-45 animate-pulse"></span>
                        </div>

                        <h2 className="text-2xl md:text-3xl font-black leading-tight text-white mb-2 uppercase italic tracking-wide drop-shadow-lg min-h-[4rem] flex items-center justify-center">
                            {question?.text || "Initializing data stream..."}
                        </h2>

                        {question?.note && (
                            <div className="mt-4 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center justify-center gap-2 animate-in fade-in slide-in-from-top-2 max-w-2xl mx-auto">
                                <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></div>
                                <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider leading-relaxed">
                                    {question.note}
                                </p>
                            </div>
                        )}
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
                                         <div className="text-xl font-black text-blue-400 uppercase tracking-wider mb-2">{myClanData?.name || "CLAN CỦA BẠN"}</div>
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
                                         <div className="text-sm font-bold text-white">Điểm số: {userScore + myClanMembers.reduce((acc, m) => acc + m.score, 0)}</div>
                                     </div>

                                     {/* Center Status */}
                                     <div className="flex flex-col items-center gap-4 text-center my-8 md:my-0">
                                         <div className="px-4 py-1 bg-white/10 rounded-full border border-white/10 text-[10px] font-black uppercase tracking-[0.3em] text-gray-400">Kết thúc câu hỏi {questionNumberInRound}</div>
                                         <div className="text-4xl md:text-6xl font-black text-white italic tracking-tighter uppercase">
                                             {isEndOfRound ? (
                                                 <>
                                                    <span>KẾT THÚC</span>
                                                    <br />
                                                    <span>HIỆP {currentRound}</span>
                                                 </>
                                             ) : (
                                                 <>
                                                    <span>CÂU HỎI</span>
                                                    <br />
                                                    <span>TIẾP THEO</span>
                                                 </>
                                             )}
                                         </div>
                                         {isEndOfRound && currentRound < maxRounds && (
                                             <div className="mt-4 px-8 py-3 bg-red-600 text-white font-black uppercase tracking-widest shadow-[0_0_30px_rgba(239,68,68,0.4)] animate-pulse"
                                                  style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                                 Chuẩn bị hiệp {currentRound + 1}...
                                             </div>
                                         )}
                                     </div>

                                     {/* Opponent Clan Team - 5 Members */}
                                     <div className="flex flex-col items-center gap-4 animate-in slide-in-from-right-20 duration-700">
                                         <div className="text-xl font-black text-red-400 uppercase tracking-wider mb-2">{oppClanData?.name || "CLAN ĐỐI THỦ"}</div>
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
                                             <span>KẾT THÚC</span>
                                             <br />
                                             <span>CÂU HỎI {questionNumberInRound}</span>
                                         </div>
                                         {isEndOfRound && currentRound < maxRounds && (
                                             <div className="mt-4 px-8 py-3 bg-red-600 text-white font-black uppercase tracking-widest shadow-[0_0_30px_rgba(239,68,68,0.4)] animate-pulse"
                                                  style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}>
                                                 Chuẩn bị hiệp {currentRound + 1}...
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

            {/* TOURNAMENT GAME OVER / RESULTS OVERLAY */}
            {isGameOver && isTournament && (
                <div className="fixed inset-0 z-[150] bg-[#050510] animate-in fade-in duration-700 overflow-y-auto h-[100dvh] custom-scrollbar font-sans">
                    {/* Cinematic Background */}
                    <div className="fixed inset-0 pointer-events-none">
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.1),transparent_70%)]"></div>
                        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>
                        <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-fuchsia-500/50 to-transparent"></div>
                        <div className="absolute inset-0 bg-dot-pattern opacity-10"></div>
                        
                        {/* Animated Glows */}
                        <div className={`absolute top-1/4 left-1/4 w-[500px] h-[500px] blur-[150px] rounded-full animate-pulse duration-[4s] ${setScores.user >= setScores.opponent ? 'bg-blue-600/20' : 'bg-red-600/20'}`}></div>
                        <div className={`absolute bottom-1/4 right-1/4 w-[500px] h-[500px] blur-[150px] rounded-full animate-pulse duration-[6s] delay-1000 ${setScores.user >= setScores.opponent ? 'bg-indigo-600/10' : 'bg-orange-600/10'}`}></div>
                    </div>

                    <div className="relative min-h-full flex flex-col items-center justify-center py-8 px-4 z-10">
                        {resultsStep === 1 ? (
                            <div className="w-full max-w-6xl animate-in fade-in slide-in-from-bottom-10 duration-700 flex flex-col items-center">
                                {/* Title Section */}
                                <div className="mb-4 md:mb-6 text-center space-y-2">
                                    <div className="flex items-center justify-center gap-4 mb-1">
                                        <div className="h-px w-12 bg-gradient-to-r from-transparent to-white/40"></div>
                                        <span className="text-xs font-black uppercase tracking-[0.5em] text-blue-400">Kết quả trận đấu</span>
                                        <div className="h-px w-12 bg-gradient-to-l from-transparent to-white/40"></div>
                                    </div>
                                    <h1 className="text-5xl md:text-7xl lg:text-8xl font-[1000] italic tracking-tighter uppercase leading-none text-transparent bg-clip-text bg-gradient-to-b from-white via-white to-gray-500 drop-shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                                        {setScores.user > setScores.opponent ? 'VICTORY' : setScores.user === setScores.opponent ? 'DRAW' : 'DEFEAT'}
                                    </h1>
                                </div>

                                {/* Main Match Card */}
                                <div className="w-full space-y-4 md:space-y-6">
                                    {/* Scoreboard Header */}
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center bg-white/[0.03] border border-white/10 backdrop-blur-3xl p-4 md:p-6 shadow-2xl relative overflow-hidden group border-l-[4px] border-r-[4px] border-r-red-500 border-l-blue-500">
                                        {/* Clan 1 */}
                                        <div className="flex flex-col items-center md:items-start gap-3 relative overflow-visible">
                                            <div className="relative z-10 space-y-0.5">
                                                <div className="text-[10px] font-black text-blue-500 uppercase tracking-widest">CLAN CỦA BẠN</div>
                                                <div className="text-xl md:text-3xl font-black text-white uppercase tracking-tighter italic">{myClanData?.name}</div>
                                            </div>
                                            <div className="absolute -left-6 top-1/2 -translate-y-1/2 opacity-[0.2] blur-[2px]">
                                                {myClanData && <ClanIcon iconName={myClanData.icon} color={myClanData.color} className="w-28 h-28 md:w-54 md:h-54" />}
                                            </div>
                                        </div>

                                        {/* Main Match Score */}
                                        <div className="flex flex-col items-center justify-center space-y-1 relative z-10">
                                            <div className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em]">TỈ SỐ TRẬN ĐẤU</div>
                                            <div className="flex items-center gap-6 md:gap-8 text-6xl md:text-8xl font-black italic tracking-tighter">
                                                <span className={setScores.user >= setScores.opponent ? 'text-white' : 'text-gray-600'}>{setScores.user}</span>
                                                <div className="h-12 md:h-16 w-px bg-white/10 rotate-12"></div>
                                                <span className={setScores.opponent >= setScores.user ? 'text-white' : 'text-gray-600'}>{setScores.opponent}</span>
                                            </div>
                                        </div>

                                        {/* Clan 2 */}
                                        <div className="flex flex-col items-center md:items-end gap-3 relative overflow-visible">
                                            <div className="absolute -right-6 top-1/2 -translate-y-1/2 opacity-[0.2] blur-[2px]">
                                                {oppClanData && <ClanIcon iconName={oppClanData.icon} color={oppClanData.color} className="w-28 h-28 md:w-54 md:h-54" />}
                                            </div>
                                            <div className="relative z-10 space-y-0.5 text-center md:text-right">
                                                <div className="text-[10px] font-black text-red-500 uppercase tracking-widest">CLAN ĐỐI THỦ</div>
                                                <div className="text-xl md:text-3xl font-black text-white uppercase tracking-tighter italic">{oppClanData?.name}</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Round Breakdown Table */}
                                    <div className="bg-white/[0.03] border border-white/5 backdrop-blur-xl p-3 md:p-4 overflow-hidden">
                                        <div className="flex items-center gap-2 mb-4 px-4">
                                            <Target size={16} className="text-fuchsia-500" />
                                            <span className="text-xs font-black uppercase tracking-widest text-white">Kết quả các hiệp đấu</span>
                                        </div>
                                        <div className="grid grid-cols-4 md:grid-cols-6 gap-3 md:gap-4">
                                            {Array.from({ length: maxRounds }).map((_, i) => (
                                                <div key={i} className={`flex flex-col border border-white/5 rounded-2xl p-2 md:p-3 transition-all duration-500 ${roundScoresRecord[i] ? 'bg-white/5' : 'opacity-20 backdrop-grayscale'}`}>
                                                    <div className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-2 pb-1 border-b border-white/5">Hiệp {i + 1}</div>
                                                    <div className="flex flex-col gap-1.5 font-black italic text-lg md:text-xl">
                                                        <div className="flex justify-between items-center text-blue-400">
                                                            <span>{roundScoresRecord[i]?.user ?? 0}</span>
                                                            <div className={`w-1 h-1 rounded-full ${roundScoresRecord[i]?.user > roundScoresRecord[i]?.opponent ? 'bg-blue-400' : 'bg-transparent'}`}></div>
                                                        </div>
                                                        <div className="flex justify-between items-center text-red-400">
                                                            <span>{roundScoresRecord[i]?.opponent ?? 0}</span>
                                                            <div className={`w-1 h-1 rounded-full ${roundScoresRecord[i]?.opponent > roundScoresRecord[i]?.user ? 'bg-red-400' : 'bg-transparent'}`}></div>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Navigation Step 1 */}
                                    <div className="flex justify-center mt-4 md:mt-6">
                                        <button 
                                            onClick={() => setResultsStep(2)}
                                            className="px-12 py-4 md:px-16 md:py-5 bg-white text-black font-black uppercase tracking-widest hover:scale-[1.05] active:scale-[0.95] transition-all relative overflow-hidden group shadow-[0_20px_40px_rgba(255,255,255,0.15)]"
                                            style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                        >
                                            <span className="relative z-10 flex items-center justify-center gap-3 text-sm md:text-base">
                                                TIẾP TỤC
                                            </span>
                                            <div className="absolute inset-0 bg-blue-600 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="w-full max-w-6xl animate-in fade-in slide-in-from-bottom-10 duration-700 space-y-4 md:space-y-6">
                                {/* Players List 5v5 */}
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 items-start">
                                    {/* MY TEAM */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between px-4">
                                            <div className="flex items-center gap-2">
                                                <Users size={16} className="text-blue-500" />
                                                <span className="text-xs font-black uppercase tracking-widest text-white">{myClanData?.name} ROSTER</span>
                                            </div>
                                            <span className="text-[9px] font-bold text-gray-500">ĐIỂM SỐ TRẬN ĐẤU</span>
                                        </div>
                                        <div className="space-y-1.5 md:space-y-2">
                                            {/* User Me */}
                                            <div className={`flex items-center justify-between p-3 md:p-4 border border-white/5 relative group transition-all duration-300 ${mvp?.id === userId ? 'bg-gradient-to-r from-yellow-500/20 via-yellow-600/10 to-transparent border-yellow-500/30' : 'bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/20'}`}>
                                                <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-blue-500"></div>
                                                <div className="flex items-center gap-3">
                                                    <div className="relative">
                                                        <img src={profile?.avatar_url} className="w-10 h-10 md:w-12 md:h-12 rounded-xl object-cover border border-white/10" alt="ME" />
                                                        {mvp?.id === userId && (
                                                            <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-black p-0.5 md:p-1 rounded-lg">
                                                                <Crown size={10} fill="currentColor" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className={`text-xs md:text-sm font-black italic uppercase ${mvp?.id === userId ? 'text-yellow-500' : 'text-white'}`}>{profile?.display_name}</span>
                                                        <div className="flex items-center gap-1.5">
                                                            <span className={`text-[9px] md:text-[10px] font-bold tracking-widest uppercase ${mvp?.id === userId ? 'text-yellow-600/80' : 'text-blue-400/60'}`}>YOU</span>
                                                            {mvp?.id === userId && <span className="text-[9px] md:text-[10px] font-black text-yellow-500 uppercase tracking-widest">(MVP)</span>}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className={`text-xl md:text-2xl font-black italic ${mvp?.id === userId ? 'text-yellow-500' : 'text-white'}`}>{userScore}</div>
                                            </div>
                                            {/* AI Teammates */}
                                            {myClanMembers.map((m, i) => (
                                                <div key={i} className={`flex items-center justify-between p-3 md:p-4 border border-white/5 relative transition-all duration-300 hover:border-white/20 ${mvp?.id === m.id ? 'bg-gradient-to-r from-yellow-500/20 via-yellow-600/10 to-transparent border-yellow-500/30' : 'bg-white/5'}`}>
                                                    <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-blue-500"></div>
                                                    <div className="flex items-center gap-3">
                                                        <div className="relative">
                                                            <img src={m.avatar} className="w-10 h-10 md:w-12 md:h-12 rounded-xl object-cover border border-white/10 opacity-70" alt={m.name} />
                                                            {mvp?.id === m.id && (
                                                                <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-black p-0.5 md:p-1 rounded-lg">
                                                                    <Crown size={10} fill="currentColor" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className={`text-xs md:text-sm font-black uppercase italic ${mvp?.id === m.id ? 'text-yellow-500' : 'text-gray-300'}`}>{m.name}</span>
                                                            {mvp?.id === m.id && <span className="text-[9px] md:text-[10px] font-black text-yellow-500 uppercase tracking-widest">MVP</span>}
                                                        </div>
                                                    </div>
                                                    <div className={`text-xl md:text-2xl font-black italic ${mvp?.id === m.id ? 'text-yellow-500' : 'text-gray-400'}`}>{m.score}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* OPPONENT TEAM */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between px-4">
                                            <span className="text-[9px] font-bold text-gray-500">ĐIỂM SỐ TRẬN ĐẤU</span>
                                            <div className="flex items-center gap-2">
                                                <Users size={16} className="text-red-500" />
                                                <span className="text-xs font-black uppercase tracking-widest text-white">{oppClanData?.name} ROSTER</span>
                                            </div>
                                        </div>
                                        <div className="space-y-1.5 md:space-y-2">
                                            {opponentClanMembers.map((m, i) => (
                                                <div key={i} className={`flex items-center justify-between p-3 md:p-4 border border-white/5 relative transition-all duration-300 hover:border-white/20 ${mvp?.id === m.id ? 'bg-gradient-to-l from-yellow-500/20 via-yellow-600/10 to-transparent border-yellow-500/30' : 'bg-white/5'}`}>
                                                    <div className="absolute right-0 top-0 bottom-0 w-[3px] bg-red-500"></div>
                                                   
                                                    <div className={`text-xl md:text-2xl font-black italic ${mvp?.id === m.id ? 'text-yellow-500' : 'text-gray-400'}`}>{m.score}</div>
                                                     <div className="flex items-center gap-3">
                                                        <div className="relative">
                                                            <img src={m.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${m.id}`} className="w-10 h-10 md:w-12 md:h-12 rounded-xl object-cover border border-white/10 opacity-70" alt={m.name} />
                                                            {mvp?.id === m.id && (
                                                                <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-black p-0.5 md:p-1 rounded-lg">
                                                                    <Crown size={10} fill="currentColor" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className={`text-xs md:text-sm font-black uppercase italic ${mvp?.id === m.id ? 'text-yellow-500' : 'text-gray-300'}`}>{m.name}</span>
                                                            {mvp?.id === m.id && <span className="text-[9px] md:text-[10px] font-black text-yellow-500 uppercase tracking-widest">MVP</span>}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* Navigation Actions */}
                                <div className="flex flex-col md:flex-row gap-3 w-full max-w-xl mx-auto pt-2 md:pt-4">
                                    <button 
                                        onClick={() => setResultsStep(1)}
                                        className="flex-1 py-4 md:py-5 bg-white/5 border border-white/10 text-white text-sm md:text-base font-black uppercase tracking-widest hover:bg-white/10 transition-all"
                                        style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                    >
                                        QUAY LẠI
                                    </button>
                                    <button 
                                        onClick={async () => {
                                            setIsNavigatingAway(true);
                                            await leaveRoom();
                                            if (isTournament) {
                                                navigate('/dashboard/tournament/bracket');
                                            } else {
                                                navigate('/dashboard/arena');
                                            }
                                        }}
                                        className="flex-[1] py-4 md:py-5 bg-gradient-to-r from-blue-600 to-blue-700 text-white text-sm md:text-base font-black uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] transition-all relative overflow-hidden group shadow-[0_20px_40px_rgba(37,99,235,0.2)]"
                                        style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                    >
                                        <span className="relative z-10 flex items-center justify-center gap-3">
                                            VỀ SẢNH CHÍNH
                                        </span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Standard Game Over / Results Overlay (Non-Tournament) */}
            {isGameOver && !isTournament && (
                <div className="fixed inset-0 z-[70] bg-neutral-950 animate-in fade-in duration-500 overflow-y-auto h-[100dvh] custom-scrollbar">
                    <div className="absolute inset-0 z-0">
                        <div className={`absolute inset-0 ${setScores.user > setScores.opponent ? 'bg-blue-900/60' : setScores.user < setScores.opponent ? 'bg-red-900/60' : 'bg-neutral-900/60'} mix-blend-overlay fixed inset-0`}></div>
                        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-neutral-950/20 fixed inset-0"></div>
                        <div className="absolute inset-0 bg-grid-pattern opacity-20 pointer-events-none fixed inset-0"></div>
                    </div>

                    <div className="min-h-full flex flex-col items-center justify-center p-4 py-6 relative z-10 text-center">
                        {resultsStep === 1 ? (
                            <div className="w-full max-w-4xl animate-in zoom-in-95 duration-700 flex flex-col items-center">
                                <div className="relative mb-6 md:mb-8 mt-4 md:mt-0">
                                    <h1 className="text-4xl md:text-7xl lg:text-8xl font-black uppercase tracking-tighter italic leading-none text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-500 drop-shadow-2xl">
                                        {setScores.user > setScores.opponent ? 'VICTORY' : setScores.user === setScores.opponent ? 'DRAW' : 'DEFEAT'}
                                    </h1>
                                    <div className="w-24 md:w-32 h-1 bg-gradient-to-r from-transparent via-white/50 to-transparent mx-auto mt-4"></div>
                                </div>

                        <div className="relative grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-16 w-full max-w-4xl mb-6 z-10">
                             {/* My Score */}
                             <div className={`relative p-6 md:p-8 border-2 ${setScores.user >= setScores.opponent ? 'bg-blue-900/40 border-blue-500/50' : 'bg-neutral-900/40 border-white/10'} backdrop-blur-xl animate-in slide-in-from-left-20 duration-1000 overflow-hidden group`}
                                  style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                 
                                 <div className="absolute -right-4 top-1/2 -translate-y-1/2 text-[8rem] md:text-9xl font-black text-white/5 italic select-none">{setScores.user}</div>
                                 
                                 <div className="relative z-10 flex flex-col items-center">
                                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl overflow-hidden border-2 border-white/20 mb-4 shadow-2xl skew-x-[-5deg]">
                                         <img src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"} className="w-full h-full object-cover scale-110" alt="Me" />
                                     </div>
                                     <div className="text-gray-400 font-bold uppercase text-[10px] tracking-[0.3em] mb-1">Điểm số các hiệp</div>
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
                                     <div className="text-gray-400 font-bold uppercase text-[10px] tracking-[0.3em] mb-1">Điểm số các hiệp</div>
                                     <div className="text-4xl md:text-5xl font-black text-white tracking-tighter mb-4">{opponentScore}</div>
                                 </div>
                             </div>
                        </div>

                                <button 
                                    onClick={() => setResultsStep(2)}
                                    className="relative px-12 py-5 bg-white text-black font-black uppercase tracking-widest hover:scale-105 transition-transform active:scale-95 shadow-[0_0_50px_rgba(255,255,255,0.4)] z-[75]"
                                    style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                >
                                    TIẾP TỤC
                                </button>
                            </div>
                        ) : (
                            <div className="w-full max-w-4xl animate-in zoom-in-95 duration-700 flex flex-col items-center">
                                {isRanked && showMMRSummary ? (
                                    <div className="fixed inset-0 z-[120] bg-neutral-950 flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-500 overflow-y-auto p-4 py-10">
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
                                    <div className="w-full flex flex-col items-center">
                                        <div className="text-[10px] font-black text-gray-500 uppercase tracking-[0.5em] mb-6 md:mb-8">INDIVIDUAL PERFORMANCE</div>
                                        
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 w-full mb-4 md:mb-6">
                                            {/* My Point Details */}
                                            <div className="bg-white/5 border border-white/10 p-4 md:p-5 rounded-3xl flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <img src={profile?.avatar_url} className="w-10 h-10 md:w-12 md:h-12 rounded-xl object-cover" alt="ME" />
                                                    <div className="text-left">
                                                        <div className="text-xs md:text-sm font-black text-white italic uppercase">{profile?.display_name}</div>
                                                        <div className="text-[9px] font-bold text-blue-400 uppercase tracking-widest">YOU</div>
                                                    </div>
                                                </div>
                                                <div className="text-2xl md:text-3xl font-black italic text-white">{userScore} PTS</div>
                                            </div>

                                            {/* Opponent Point Details */}
                                            <div className="bg-white/5 border border-white/10 p-4 md:p-5 rounded-3xl flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <img src={opponent?.avatar_url} className="w-10 h-10 md:w-12 md:h-12 rounded-xl object-cover" alt="OPP" />
                                                    <div className="text-left">
                                                        <div className="text-xs md:text-sm font-black text-gray-300 italic uppercase">{opponent?.display_name}</div>
                                                        <div className="text-[9px] font-bold text-red-400 uppercase tracking-widest">OPPONENT</div>
                                                    </div>
                                                </div>
                                                <div className="text-2xl md:text-3xl font-black italic text-white">{opponentScore} PTS</div>
                                            </div>
                                        </div>

                                        <div className="flex flex-col md:flex-row gap-3 w-full max-w-md">
                                            <button 
                                                onClick={() => setResultsStep(1)}
                                                className="flex-1 py-4 md:py-5 bg-white/5 border border-white/10 text-white text-sm md:text-base font-black uppercase tracking-widest hover:bg-white/10 transition-all"
                                                style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                            >
                                                QUAY LẠI
                                            </button>
                                            <button 
                                                onClick={async () => {
                                                    const isWin = setScores.user > setScores.opponent;
                                                    const isDraw = setScores.user === setScores.opponent;
                                                    const result = isWin ? 'Chiến thắng' : (isDraw ? 'Hòa' : 'Thất bại');

                                                    let mode = 'Normal';
                                                    if (isRanked) mode = 'Ranked';
                                                    else if (isBot) mode = 'Bot';
                                                    else if ((location.state as GameLocationState)?.isCustom) mode = 'Custom';

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
                                                className="flex-[2] py-4 md:py-5 bg-white text-black text-sm md:text-base font-black uppercase tracking-widest hover:scale-105 transition-transform active:scale-95 shadow-[0_0_50px_rgba(255,255,255,0.4)] z-[75]"
                                                style={{ clipPath: 'polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px)' }}
                                            >
                                                {isRanked ? 'XEM XẾP HẠNG' : 'VỀ SẢNH CHÍNH'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
            
            {/* Round Intro Overlay (Black Screen) */}
            {showRoundIntro && (
                <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center animate-in fade-in duration-700">
                    <div className="flex flex-col items-center gap-4 animate-in zoom-in-50 duration-500">
                         <div className="w-20 h-1 bg-white/20 rounded-full mb-4"></div>
                         <h1 className="text-6xl md:text-9xl font-black text-white tracking-[0.2em] italic">HIỆP {currentRound}</h1>
                         <div className="w-20 h-1 bg-white/20 rounded-full mt-4"></div>
                         <p className="text-gray-500 font-bold uppercase tracking-[0.5em] animate-pulse">Bắt đầu round đấu...</p>
                    </div>
                </div>
            )}

            {/* Set Result (Face-off Style) Overlay */}
            {showSetResults && (
                <div className="fixed inset-0 z-[90] bg-neutral-950 animate-in fade-in duration-500 overflow-y-auto custom-scrollbar">
                    <div className="min-h-full flex flex-col items-center justify-center p-4 py-4 relative">
                        <div className="absolute inset-0 bg-dot-pattern opacity-10 fixed"></div>
                        <div className="absolute top-0 w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent fixed"></div>
                        <div className="absolute bottom-0 w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent fixed"></div>
                        
                        <div className="relative mb-6 text-center z-10">
                            <h2 className="text-3xl md:text-5xl font-black text-white uppercase italic tracking-tighter mb-8 animate-in slide-in-from-top-10 duration-700">HIỆP {currentRound} HOÀN TẤT</h2>
                            
                            <div className="px-8 py-4 bg-white/5 border border-white/10 backdrop-blur-xl relative" style={{ clipPath: 'polygon(20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%, 0 20px)' }}>
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-[0.4em] mb-2 block">Match Score</span>
                                <div className="text-5xl md:text-7xl font-black text-white tracking-widest flex items-center justify-center gap-8">
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
                                    <div className="w-20 h-20 md:w-32 md:h-32 rounded-3xl border-2 border-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.3)] bg-neutral-900 p-1 rotate-[-3deg]"
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
                                    <div className="w-20 h-20 md:w-32 md:h-32 rounded-3xl border-2 border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)] bg-neutral-900 p-1 rotate-[3deg]"
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
                <div className="fixed inset-0 z-[200] bg-black overflow-y-auto font-sans">
                     <div className="fixed inset-0 bg-neutral-900">
                         {/* Background Effects */}
                         <div className="absolute inset-0 bg-grid-pattern opacity-10"></div>
                         <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-fuchsia-900/20 to-transparent"></div>
                         <div className="absolute bottom-0 left-0 w-full h-[500px] bg-gradient-to-t from-blue-900/20 to-transparent"></div>
                     </div>

                     <div className="relative min-h-full z-10 w-full max-w-7xl flex flex-col items-center justify-center py-10 px-4 gap-12">
                         {/* Header */}
                         <div className="text-center space-y-2">
                             <div className="px-6 py-2 bg-white/5 border border-white/10 rounded-full inline-flex items-center gap-2 backdrop-blur-md">
                                 <Trophy size={16} className="text-yellow-500" />
                                 <span className="text-xs font-black uppercase tracking-[0.3em] text-white">Tournament Match</span>
                             </div>
                              <h1 className="text-4xl md:text-6xl font-black text-white uppercase italic tracking-tighter">
                                  Đại chiến <span className="text-fuchsia-500">5 vs 5 </span>
                              </h1>
                         </div>

                         {/* VS Area */}
                         <div className="flex items-center justify-center gap-12 md:gap-24 w-full">
                             {/* My Team - 5 Members Horizontal */}
                             <div className="flex flex-col items-center gap-6 animate-in slide-in-from-left-20 duration-700">
                                 <div className="text-2xl font-black text-blue-400 uppercase tracking-wider">{myClanData?.name || "CLAN CỦA BẠN"}</div>
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
                                     <span className="text-6xl font-black text-fuchsia-500 italic tracking-tighter animate-in zoom-in-50 duration-300">
                                        FIGHT!
                                    </span>
                                 )}
                             </div>

                             {/* Opponent Team - 5 Members Horizontal */}
                             <div className="flex flex-col items-center gap-6 animate-in slide-in-from-right-20 duration-700">
                                 <div className="text-2xl font-black text-red-400 uppercase tracking-wider">{oppClanData?.name || "CLAN ĐỐI THỦ"}</div>
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
        <div className="relative flex flex-col items-center text-center max-w-4xl w-full px-4 z-10 animate-in fade-in slide-in-from-bottom-10 duration-700 min-h-full py-8 no-scrollbar">
            <h2 className="text-[10px] md:text-sm font-black text-gray-500 uppercase tracking-[0.5em] mb-4 shrink-0 flex items-center gap-4">
                <div className="h-px w-8 bg-gray-500/30"></div>
                RANK PERFORMANCE
                <div className="h-px w-8 bg-gray-500/30"></div>
            </h2>
            
            <div className="flex flex-col items-center justify-center w-full mb-4 shrink-0">
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

                    <h3 className="text-4xl md:text-5xl font-black text-white uppercase italic tracking-tighter mb-4 drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]">
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
            <div className="flex flex-col md:flex-row items-center justify-center gap-8 w-full max-w-5xl bg-neutral-900/60 border border-white/5 p-4 backdrop-blur-xl shrink-0" 
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
