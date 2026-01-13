import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOutletContext, useNavigate, useParams, useLocation } from 'react-router-dom';
import { 
  Trophy, 
  Calendar, 
  Users, 
  ArrowLeft, 
  Share2, 
  Shield, 
  Clock, 
  Swords, 
  Award,
  MoreVertical,
  Eye,
  ChevronRight,
  Coins,
  AlertTriangle,
  Loader2,
  Aperture,
  Zap
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { TOURNAMENT_CONFIG } from '../../lib/constants';
import Toast, { type ToastType } from '../../components/Toast';
import { CLAN_ICONS } from './clanConstants';

// --- Phases ---
type TournamentPhase = 'waiting' | 'shuffling' | 'preparation' | 'live';

interface Match {
  id: string;
  clan1: ClanInfo | null;
  clan2: ClanInfo | null;
  round: number;
  order: number;
  scheduledTime: string; // ISO string
  winnerId?: string;
  winnerClan?: ClanInfo | null;
  score1?: number;
  score2?: number;
  status?: 'waiting' | 'live' | 'completed';
  actualDuration?: number; // in seconds
}

// --- Icon Component Helper ---
const ClanIconDisplay = ({ iconName, color, className = "w-6 h-6" }: { iconName: string, color: string, className?: string }) => {
  // Find the icon object from the array
  const iconObj = CLAN_ICONS.find(item => item.id === iconName);
  const IconComponent = iconObj ? iconObj.icon : Shield;
  
  return <IconComponent className={className} style={{ color: color }} />;
};

interface ClanInfo {
  id: string;
  name: string;
  tag: string;
  role?: string;
  avatar_url?: string;
  icon?: string;
  color?: string;
  members_count?: number;
}


interface DashboardContext {
  dashboardCache: {
    clanInfo?: ClanInfo | null;
    [key: string]: unknown;
  };
}

// Interfaces for fetched data
interface Tournament {
  id: string;
  title: string;
  status: string;
  prize_pool: string;
  entry_fee: number;
  max_participants: number;
  start_date: string;
  end_date: string;
  tournament_type: string;
  image_url: string;
  description: string;
  rules: string[];
  prizes: { rank: string; reward: string; special?: string }[];
}

interface TournamentRegistration {
  id: string;
  clan_id: string;
  status: string;
  clans: ClanInfo;
}

const SkeletonBox = ({ className = '' }: { className?: string }) => (
  <div className={`bg-neutral-800 rounded animate-pulse ${className}`}></div>
);

const TournamentDetailView = () => {
  const { dashboardCache } = useOutletContext<DashboardContext>();
  const { id } = useParams<{ id: string }>(); // Get ID from URL
  const navigate = useNavigate();
  const location = useLocation();
  
  // Use URL to determine active tab
  const activeTab = useMemo(() => {
    const parts = location.pathname.split('/');
    const lastPart = parts[parts.length - 1];
    const validTabs = ['overview', 'bracket', 'clans', 'match'];
    if (validTabs.includes(lastPart)) return lastPart;
    // Handle old 'teams' state or default
    if (location.state?.returnTab === 'teams') return 'clans';
    return 'overview';
  }, [location.pathname, location.state]);

  const setActiveTab = (tab: string) => {
    navigate(`/dashboard/tournaments/${id}/${tab}`);
  };

  // Synchronize URL if at root ID
  useEffect(() => {
    if (id && location.pathname.endsWith(id)) {
      navigate(`/dashboard/tournaments/${id}/overview`, { replace: true });
    }
  }, [id, location.pathname, navigate]);

  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Use the clan info from global cache
  const clanInfo = dashboardCache.clanInfo;

  // Fallback/Mock data if DB is empty or during transition
  const defaultTournament: Tournament = useMemo(() => ({
    id: TOURNAMENT_CONFIG.ID,
    title: TOURNAMENT_CONFIG.TITLE,
    status: 'Sắp diễn ra',
    start_date: TOURNAMENT_CONFIG.DISPLAY_DATE,
    end_date: '15 Jan, 2026',
    tournament_type: TOURNAMENT_CONFIG.TYPE,
    prize_pool: TOURNAMENT_CONFIG.PRIZE_POOL,
    max_participants: TOURNAMENT_CONFIG.MAX_PARTICIPANTS,
    entry_fee: TOURNAMENT_CONFIG.ENTRY_FEE,
    image_url: TOURNAMENT_CONFIG.IMAGE,
    description: 'Giải đấu thường niên dành cho cộng đồng MillionMind. Nơi quy tụ những cao thủ hàng đầu để tranh tài và giành lấy vinh quang.',
    rules: [
      'Thi đấu theo thể thức loại trực tiếp (Single Elimination).',
      'Mỗi trận đấu diễn ra trong 30 phút.',
      'Người chơi phải có mặt trước 15 phút.',
      'Nghiêm cấm mọi hành vi gian lận.'
    ],
    prizes: [
      { rank: '1st', reward: '3.000/Thành viên ',special:'Huy hiệu độc quyền' },
      { rank: '2nd', reward: '2.000/Thành viên ' },
      { rank: '3rd', reward: '1.000/Thành viên ' }
    ]
  }), []);

  const [tournament, setTournament] = useState<Tournament | null>(defaultTournament);
  const [registrations, setRegistrations] = useState<TournamentRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRegistered, setIsRegistered] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date().getTime());
  const [toast, setToast] = useState<{ message: React.ReactNode, type: ToastType } | null>(null);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorType, setErrorType] = useState<'role' | 'no-clan' | 'member-count' | null>(null);
  
  const currentData = tournament || defaultTournament;

  // Tournament Timing & Bracket State
  const [phase, setPhase] = useState<TournamentPhase>('waiting');
  const [matches, setMatches] = useState<Match[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [isFetchingRegs, setIsFetchingRegs] = useState(true);

  // Dropdown state
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchTournamentData = useCallback(async () => {
    if (!id) return;
    
    // Immediate render of tournament info (parallel)
    // setTournament(defaultTournament); // Initialized in useState now

    // Fetch registrations in background
    setIsFetchingRegs(true);
    
    try {
        // 2. Fetch Registrations (Real Data)
        const { data: regData, error: regError } = await supabase
            .from('tournament_registrations')
            .select(`
                id,
                clan_id,
                status,
                clans (
                    id,
                    name,
                    tag,
                    icon,
                    color
                )
            `)
            .eq('tournament_id', id);

        if (regError) throw regError;
        
        const formattedRegs = regData?.map(item => ({
            id: item.id,
            clan_id: item.clan_id,
            status: item.status,
            clans: Array.isArray(item.clans) ? item.clans[0] : item.clans
        })) as unknown as TournamentRegistration[];

        setRegistrations(formattedRegs || []);
         // Removed "Check if current user's clan is registered" from here
    } catch (err) {
        console.error('Error in fetchTournamentData:', err);
    } finally {
        setIsFetchingRegs(false);
        setLoading(false); 
    }
  }, [id]); // Removed clanInfo?.id and defaultTournament from dependencies

  // Separate effect to check registration status when data or clanInfo updates
  useEffect(() => {
    if (clanInfo?.id && registrations.length > 0) {
        const isReg = registrations.some(r => r.clan_id === clanInfo.id && ['confirmed', 'approved'].includes(r.status));
        setIsRegistered(!!isReg);
    }
  }, [registrations, clanInfo?.id]);

  // Phase & Bracket Management Logic
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().getTime());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const startTimeDate = new Date(TOURNAMENT_CONFIG.START_TIME);
    const startTime = startTimeDate.getTime();
    const shuffleEndTime = startTime + 60 * 1000; // 1 min shuffle
    const prepEndTime = shuffleEndTime + 5 * 60 * 1000; // 5 min prep

    if (currentTime < startTime) {
      if (phase !== 'waiting') setPhase('waiting');
      setTimeLeft(Math.floor((startTime - currentTime) / 1000));
    } else if (currentTime < shuffleEndTime) {
      if (phase !== 'shuffling') setPhase('shuffling');
      setTimeLeft(Math.floor((shuffleEndTime - currentTime) / 1000));
    } else if (currentTime < prepEndTime) {
      if (phase !== 'preparation') setPhase('preparation');
      setTimeLeft(Math.floor((prepEndTime - currentTime) / 1000));
    } else {
      if (phase !== 'live') setPhase('live');
      setTimeLeft(0);
    }
  }, [currentTime, phase]);

  // Generate Bracket when shuffling or preparation starts
  useEffect(() => {
    if ((phase === 'shuffling' || phase === 'preparation' || phase === 'live') && registrations.length > 0 && matches.length === 0) {
      const storageKey = `bracket_${id}_${TOURNAMENT_CONFIG.START_TIME}`;
      const savedBracket = localStorage.getItem(storageKey);

      if (savedBracket) {
        const parsedMatches: Match[] = JSON.parse(savedBracket);
        // Count unique clans in round 1 of the saved bracket
        const r1Clans = parsedMatches.filter(m => m.round === 1).reduce((acc, m) => {
          if (m.clan1) acc.add(m.clan1.id);
          if (m.clan2) acc.add(m.clan2.id);
          return acc;
        }, new Set<string>());
        
        // If the number of real clans in the saved bracket doesn't match the current registrations, clear it
        if (r1Clans.size !== registrations.length) {
          localStorage.removeItem(storageKey);
          setMatches([]);
          return; // Next render will regenerate
        }
        setMatches(parsedMatches);
      } else {
        const N = registrations.length;
        if (N === 0) return;

        const P = Math.pow(2, Math.ceil(Math.log2(N)));
        const B = P - N; 
        
        const shuffled = [...registrations].sort(() => Math.random() - 0.5);
        const newMatches: Match[] = [];
        const baseStartTime = new Date(new Date(TOURNAMENT_CONFIG.START_TIME).getTime() + 6 * 60000);
        let globalMatchIdx = 0;

        const getNextTime = () => {
          const time = new Date(baseStartTime.getTime() + globalMatchIdx * 2 * 60000);
          globalMatchIdx++;
          return time.toISOString();
        };

        const r1Count = P / 2;
        let teamsIndex = 0;
        let byesDistributed = 0;

        for (let i = 0; i < r1Count; i++) {
          let clan1: ClanInfo | null = null;
          let clan2: ClanInfo | null = null;
          clan1 = shuffled[teamsIndex]?.clans || null;
          teamsIndex++;
          if (byesDistributed < B) {
            clan2 = null; 
            byesDistributed++;
          } else {
            clan2 = shuffled[teamsIndex]?.clans || null;
            teamsIndex++;
          }
          newMatches.push({ id: `r1-m${i}`, clan1, clan2, round: 1, order: i, scheduledTime: getNextTime(), status: 'waiting' });
        }

        let currentRoundCount = r1Count / 2;
        let roundNum = 2;
        while (currentRoundCount >= 1) {
          for (let i = 0; i < currentRoundCount; i++) {
            newMatches.push({ id: `r${roundNum}-m${i}`, clan1: null, clan2: null, round: roundNum, order: i, scheduledTime: getNextTime(), status: 'waiting' });
          }
          currentRoundCount /= 2;
          roundNum++;
        }
        
        localStorage.setItem(storageKey, JSON.stringify(newMatches));
        setMatches(newMatches);
      }
    } else if (matches.length > 0) {
      const currentKey = `bracket_${id}_${TOURNAMENT_CONFIG.START_TIME}`;
      if (!localStorage.getItem(currentKey)) {
          setMatches([]);
      }
    }
  }, [phase, registrations, id, matches.length, registrations.length]);

  // --- Tournament Simulation Engine ---
  useEffect(() => {
    if (phase !== 'live' && phase !== 'preparation') return;
    if (matches.length === 0) return;

    let changed = false;
    const updatedMatches = [...matches];

    updatedMatches.forEach(match => {
      if (match.status === 'completed') return;

      const matchStartTime = new Date(match.scheduledTime).getTime();
      const now = currentTime;

      // Handle Byes in Round 1
      if (match.round === 1 && !match.clan2 && match.clan1) {
          match.status = 'completed';
          match.winnerId = match.clan1.id;
          match.winnerClan = match.clan1;
          match.score1 = 3;
          match.score2 = 0;
          changed = true;

          const nextRound = match.round + 1;
          const nextOrder = Math.floor(match.order / 2);
          const nextMatch = updatedMatches.find(m => m.round === nextRound && m.order === nextOrder);
          if (nextMatch) {
            if (match.order % 2 === 0) nextMatch.clan1 = match.clan1;
            else nextMatch.clan2 = match.clan1;
          }
          return;
      }

      // If both clans are present and we reach start time
      if (match.clan1 && match.clan2) {
          if (now >= matchStartTime && match.status !== 'live') {
              match.status = 'live';
              // Random duration between 40s and 90s for simulation speed
              match.actualDuration = 40 + Math.floor(Math.random() * 50);
              match.score1 = 0;
              match.score2 = 0;
              changed = true;
          }

          if (match.status === 'live' && match.actualDuration) {
              const elapsedSeconds = Math.floor((now - matchStartTime) / 1000);
              
              // Increment scores occasionally for visual effect
              if (elapsedSeconds > 0 && elapsedSeconds % 10 === 0 && (match.score1! + match.score2! < 5)) {
                  if (Math.random() > 0.5) match.score1 = Math.min(3, match.score1! + 1);
                  else match.score2 = Math.min(3, match.score2! + 1);
                  changed = true;
              }

              if (elapsedSeconds >= match.actualDuration) {
                  match.status = 'completed';
                  // Final result: must reach 3 in BO5
                  const winThreshold = 3;
                  if (match.score1! < winThreshold && match.score2! < winThreshold) {
                      if (Math.random() > 0.5) match.score1 = winThreshold;
                      else match.score2 = winThreshold;
                  }
                  
                  const isClan1Winner = match.score1! > match.score2!;
                  const matchWinner = isClan1Winner ? match.clan1 : match.clan2;
                  
                  match.winnerId = matchWinner!.id;
                  match.winnerClan = matchWinner;
                  changed = true;

                  const nextRound = match.round + 1;
                  const nextOrder = Math.floor(match.order / 2);
                  const nextMatch = updatedMatches.find(m => m.round === nextRound && m.order === nextOrder);
                  if (nextMatch) {
                    if (match.order % 2 === 0) nextMatch.clan1 = matchWinner;
                    else nextMatch.clan2 = matchWinner;
                  }
              }
          }
      } else if (match.status === 'live' && (!match.clan1 || !match.clan2)) {
          // Fallback for safety
          match.status = 'waiting';
          changed = true;
      }
    });

    if (changed) {
      setMatches(updatedMatches);
      localStorage.setItem(`bracket_${id}_${TOURNAMENT_CONFIG.START_TIME}`, JSON.stringify(updatedMatches));
    }
  }, [currentTime, phase, matches, id]);

  useEffect(() => {
    fetchTournamentData();
  }, [fetchTournamentData]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
         setOpenDropdownId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentParticipants = registrations.length;
  const maxParticipants = currentData.max_participants;
  const isFull = currentParticipants >= maxParticipants;
  const participantsDisplay = `${currentParticipants}/${maxParticipants}`;

  const handleRegisterClick = () => {
    if (!clanInfo) { setErrorType('no-clan'); setShowErrorModal(true); return; }
    if (clanInfo.role !== 'leader') { setErrorType('role'); setShowErrorModal(true); return; }
    if ((clanInfo.members_count || 0) < 5) { setErrorType('member-count'); setShowErrorModal(true); return; }
    setShowConfirmModal(true);
  };

  const handleConfirmRegistration = async () => {
    if (!clanInfo?.id || !id) return;
    setIsRegistering(true);
    try {
      const fee = typeof currentData.entry_fee === 'string' 
          ? parseInt((currentData.entry_fee as string).replace('.', '')) 
          : currentData.entry_fee;
      const { error } = await supabase.rpc('register_clan_for_tournament', {
        p_tournament_id: id, p_clan_id: clanInfo.id, p_fee: fee
      });
      if (error) throw error;
      setShowConfirmModal(false);
      setToast({ message: (<div className="flex flex-col gap-1"><span className="font-bold">Đăng ký thành công!</span><span className="text-xs opacity-90">Phí tham dự đã được trừ vào tài khoản.</span></div>), type: 'success' });
      await fetchTournamentData();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Đăng ký thất bại. Vui lòng thử lại.";
      setToast({ message: errorMessage, type: 'error' });
      setShowConfirmModal(false);
    } finally {
      setIsRegistering(false);
    }
  };

  const toggleDropdown = (dropdownId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openDropdownId === dropdownId) setOpenDropdownId(null);
    else setOpenDropdownId(dropdownId);
  };

  const handleViewClanDetails = (clanId: string) => {
      navigate(`/dashboard/clan?id=${clanId}`, { state: { returnTo: location.pathname, returnTab: 'teams' } }); 
  };

  // No early return for loading to allow granular skeletons in the JSX

  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* Navigation & Actions */}
      <div className="flex justify-between items-center">
        <button onClick={() => navigate('/dashboard/tournaments')} className="group flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
          <div className="p-2 bg-neutral-900 border border-white/10 rounded-lg group-hover:border-fuchsia-500/50 transition-all"><ArrowLeft size={20} /></div>
          <span className="text-sm font-bold uppercase tracking-wider">Quay lại</span>
        </button>
        <button className="flex items-center gap-2 px-4 py-2 bg-neutral-900 border border-white/10 text-gray-400 hover:text-white hover:border-fuchsia-500/30 transition-all rounded-lg"><Share2 size={18} /><span className="text-xs font-bold uppercase tracking-wider">Chia sẻ</span></button>
      </div>

      {/* Hero Section */}
      <div className="relative min-h-[400px] border border-white/5 bg-neutral-950 overflow-hidden group">
        <div className="absolute inset-0">
          <img src={currentData.image_url} alt={currentData.title} className="w-full h-full object-cover opacity-20 blur-sm group-hover:scale-105 transition-transform duration-1000" />
          <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-transparent" />
          <div className="absolute inset-0 bg-dot-pattern opacity-10" />
        </div>
        <div className="absolute relative z-10 h-full flex flex-col justify-end p-8 md:p-12">
          <div className="flex items-center gap-3 mb-6">
            <span className="px-3 py-1 bg-fuchsia-600/20 border border-fuchsia-500/50 text-fuchsia-400 text-[10px] font-black uppercase tracking-[0.2em] shadow-[0_0_15px_rgba(192,38,211,0.2)]">{currentData.status}</span>
            <span className="text-gray-500 text-[10px] font-black uppercase tracking-[0.2em]">// {currentData.tournament_type}</span>
          </div>
          <h1 className="text-4xl md:text-6xl font-black text-white mb-6 uppercase italic tracking-tighter max-w-4xl leading-none">
            {tournament ? currentData.title : <SkeletonBox className="h-16 w-3/4 mb-4" />}
          </h1>
          <div className="flex flex-wrap gap-8 md:gap-16 border-t border-white/10 pt-8">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-fuchsia-500/20 rounded-lg border border-fuchsia-500/20"><Trophy size={24} className="text-fuchsia-500" /></div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Tổng giải thưởng</span>
                {tournament ? (
                   <span className="flex items-center gap-2 text-xl font-black text-white italic">{currentData.prize_pool} <Coins size={20} className="text-yellow-500" /></span>
                ) : (
                  <SkeletonBox className="h-6 w-24 mt-1" />
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20"><Users size={24} className="text-blue-500" /></div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Số đội tham gia</span>
                {tournament && !isFetchingRegs ? (
                  <span className="text-xl font-black text-white italic">{participantsDisplay}</span>
                ) : (
                  <SkeletonBox className="h-6 w-16 mt-1" />
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20"><Calendar size={24} className="text-green-500" /></div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Khởi tranh</span>
                {tournament ? (
                  <span className="text-xl font-black text-white italic">{currentData.start_date}</span>
                ) : (
                  <SkeletonBox className="h-6 w-32 mt-1" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <div className="flex border-b border-white/10">
            {['overview', 'bracket', 'clans', 'match'].map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] relative transition-all ${activeTab === tab ? 'text-white' : 'text-gray-600 hover:text-gray-400'}`}>
                {tab === 'overview' ? 'Tổng quan' : tab === 'bracket' ? 'Nhánh đấu' : tab === 'clans' ? 'Đội tham gia' : 'Trận đấu'}
                {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-fuchsia-500 shadow-[0_0_10px_#d946ef]" />}
              </button>
            ))}
          </div>

          <div className="p-6 bg-neutral-900/50 border border-white/5 rounded-xl min-h-[300px]">
            {activeTab !== 'overview' && isFetchingRegs ? (
              <div className="space-y-6">
                <SkeletonBox className="h-6 w-48 mb-6" />
                <div className="space-y-4">
                  <SkeletonBox className="h-20 w-full" />
                  <SkeletonBox className="h-20 w-full" />
                  <SkeletonBox className="h-20 w-full" />
                </div>
              </div>
            ) : (
              <>
                {activeTab === 'overview' && (
                  <div className="space-y-8">
                    <div><h3 className="text-lg font-black text-white uppercase italic tracking-wider mb-4 flex items-center gap-2"><Shield size={18} className="text-fuchsia-500" /> Giới thiệu</h3><p className="text-gray-400 leading-relaxed font-medium">{currentData.description}</p></div>
                    <div><h3 className="text-lg font-black text-white uppercase italic tracking-wider mb-4 flex items-center gap-2"><Award size={18} className="text-fuchsia-500" /> Cơ cấu giải thưởng</h3><div className="grid grid-cols-1 sm:grid-cols-3 gap-4">{currentData.prizes.map((item, index) => (<div key={index} className="p-4 bg-black border border-white/5 rounded-lg flex flex-col items-center text-center gap-2"><span className={`text-sm font-black uppercase ${index === 0 ? 'text-yellow-500' : index === 1 ? 'text-gray-400' : 'text-amber-700'}`}>{item.rank} Place</span><span className="flex items-center gap-2 text-fuchsia-400 font-bold">{item.reward}<Coins size={20} className="text-yellow-500" /> </span><span className='text-fuchsia-400 font-bold'>{item.special}</span></div>))}</div></div>
                    <div><h3 className="text-lg font-black text-white uppercase italic tracking-wider mb-4 flex items-center gap-2"><Swords size={18} className="text-fuchsia-500" /> Luật thi đấu</h3><ul className="space-y-3">{currentData.rules.map((rule, idx) => (<li key={idx} className="flex items-start gap-3 text-gray-400 text-sm"><div className="w-1.5 h-1.5 rounded-full bg-fuchsia-500 mt-1.5 shrink-0" />{rule}</li>))}</ul></div>
                  </div>
                )}
            
            {activeTab === 'bracket' && (
              <div className="space-y-8 py-4">
                {phase === 'waiting' && (
                  <div className="flex flex-col items-center justify-center h-80 border border-white/5 bg-black/40 rounded-2xl relative overflow-hidden group">
                    <div className="absolute inset-0 bg-dot-pattern opacity-5" /><div className="p-6 bg-fuchsia-500/20 rounded-full mb-6 relative"><Aperture size={48} className="text-fuchsia-500/30 animate-pulse" /><div className="absolute inset-0 border-2 border-fuchsia-500/20 rounded-full animate-ping" /></div><h3 className="text-xl font-black text-white uppercase tracking-tighter italic mb-2">Nhánh đấu sẵn sàng</h3><p className="text-gray-500 text-xs font-bold uppercase tracking-widest text-center max-w-xs">Các nhánh đấu sẽ được ghép ngẫu nhiên vào lúc <span className="text-fuchsia-500">{TOURNAMENT_CONFIG.DISPLAY_TIME}</span></p><div className="mt-8 px-6 py-2 bg-neutral-900 border border-white/5 text-[10px] font-bold text-gray-500 uppercase tracking-widest">Trạng thái: Đang chờ khởi tranh</div>
                  </div>
                )}
                {phase === 'shuffling' && (
                  <div className="flex flex-col items-center justify-center h-[400px] border border-fuchsia-500/20 bg-fuchsia-950/5 rounded-2xl relative overflow-hidden"><div className="absolute inset-0 bg-scanline-fast opacity-10" /><div className="relative z-10 flex flex-col items-center"><div className="w-24 h-24 relative mb-8"><Loader2 size={96} className="text-fuchsia-500 animate-spin opacity-50 absolute inset-0" /><div className="absolute inset-0 flex items-center justify-center"><Trophy size={32} className="text-white animate-bounce" /></div></div><h3 className="text-2xl font-black text-white uppercase italic tracking-tighter mb-4 animate-pulse">Đang xáo trộn bắt cặp...</h3><div className="flex gap-2">{[1, 2, 3].map(i => (<div key={i} className="w-2 h-2 bg-fuchsia-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.2}s` }} />))}</div><p className="mt-8 text-[10px] font-black text-fuchsia-500 uppercase tracking-[0.3em] italic">Vui lòng chờ trong {timeLeft} giây</p></div></div>
                )}
                {(phase === 'preparation' || phase === 'live') && (
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-1000">
                    {phase === 'preparation' && (
                       <div className="mb-8 p-4 bg-fuchsia-500/20 border border-fuchsia-500/20 rounded-xl flex items-center justify-between shadow-[0_0_20px_rgba(192,38,211,0.1)]">
                          <div className="flex items-center gap-4"><div className="p-3 bg-fuchsia-600/20 rounded-lg"><Swords className="text-fuchsia-500 animate-pulse" size={24} /></div><div><span className="text-[10px] font-black text-fuchsia-500 uppercase tracking-[0.2em] block mb-0.5">// Giai đoạn chuẩn bị</span><h4 className="text-sm font-black text-white uppercase italic tracking-tight">Xác nhận cặp đấu - Chuẩn bị tinh thần!</h4></div></div>
                          <div className="text-right"><span className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-1">Bắt đầu sau</span><div className="flex items-center gap-1.5 justify-end"><div className="text-2xl font-black text-white tabular-nums italic">{Math.floor(timeLeft / 60).toString().padStart(2, '0')}</div><span className="text-fuchsia-600 font-bold">:</span><div className="text-2xl font-black text-white tabular-nums italic">{(timeLeft % 60).toString().padStart(2, '0')}</div></div></div>
                       </div>
                    )}
                    <div className="overflow-x-auto pb-12 scrollbar-hide relative">
                       <div className="flex px-8 py-20 w-max min-h-[900px] relative gap-20">
                          {Array.from({ length: Math.log2(Math.pow(2, Math.ceil(Math.log2(registrations.length || 16)))) }, (_, i) => i + 1).map((round) => {
                              const totalRounds = Math.log2(Math.pow(2, Math.ceil(Math.log2(registrations.length || 16))));
                              const roundMatches = matches.filter(m => m.round === round);
                              const cardHeight = 137; const baseGap = 40; const pitch = cardHeight + baseGap;
                              const currentGap = Math.pow(2, round - 1) * pitch - cardHeight;
                              const vLineHeight = (Math.pow(2, round - 1) * pitch) / 2;
                              return (
                                 <div key={round} className="bracket-column" style={{ gap: `${currentGap}px` }}>
                                    <div className="text-center absolute top-[-40px] left-0 right-0 z-20"><div className="inline-block px-5 py-2 bg-neutral-950/80 backdrop-blur-md border border-white/10 rounded-full shadow-2xl"><span className="text-[10px] font-black text-fuchsia-500 uppercase tracking-[0.3em] glow-text">{round === totalRounds ? 'Chung kết' : round === totalRounds - 1 ? 'Bán kết' : round === totalRounds - 2 ? 'Tứ kết' : `Vòng ${round}`}</span></div></div>
                                    {roundMatches.map((match) => {
                                       const matchDate = new Date(match.scheduledTime); const matchTimeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                                       const now = currentTime; const isLive = now >= matchDate.getTime() && now < (matchDate.getTime() + 2 * 60000);
                                       return (
                                         <div key={match.id} className="match-card-v3">
                                            <div className="match-time-badge"><Clock size={10} className="text-fuchsia-500" /><span>{matchTimeStr}</span>{isLive && <span className="w-1.5 h-1.5 bg-fuchsia-500 rounded-full animate-ping ml-1" />}</div>
                                            <div className={`match-box-pro ${isLive ? 'border-fuchsia-500 shadow-[0_0_30px_rgba(192,38,211,0.3)] ring-1 ring-fuchsia-500/50' : 'border-white/10'}`}>
                                               <div className={`match-team-row ${match.winnerId === match.clan1?.id && match.clan1 ? 'bg-fuchsia-500/20 shadow-inner' : ''}`}><div className="match-team-icon">{match.clan1 ? <ClanIconDisplay iconName={match.clan1.icon || 'Shield'} color={match.clan1.color || '#fff'} className="w-5 h-5" /> : <Users size={18} className="text-neutral-800" />}</div><span className={`match-team-name ${match.clan1 ? 'text-white' : 'text-neutral-800'}`}>{match.clan1?.name || 'TBD'}</span>{match.winnerId === match.clan1?.id && match.clan1 && match.round === totalRounds && <Trophy size={14} className="text-yellow-500 ml-2 animate-bounce" />}</div>
                                               <div className={`match-team-row ${match.winnerId === match.clan2?.id && match.clan2 ? 'bg-fuchsia-500/20 shadow-inner' : ''}`}><div className="match-team-icon">{match.clan2 ? <ClanIconDisplay iconName={match.clan2.icon || 'Shield'} color={match.clan2.color || '#fff'} className="w-5 h-5" /> : match.round === 1 && match.clan1 ? <Zap size={18} className="text-fuchsia-500/40" /> : <Users size={18} className="text-neutral-800" />}</div><span className={`match-team-name ${match.clan2 ? 'text-white' : match.round === 1 && match.clan1 ? 'text-fuchsia-500/40 italic' : 'text-neutral-800'}`}>{match.clan2?.name || (match.round === 1 && match.clan1 ? 'BYE (Đặc cách)' : 'TBD')}</span>{match.winnerId === match.clan2?.id && match.clan2 && match.round === totalRounds && <Trophy size={14} className="text-yellow-500 ml-2 animate-bounce" />}</div>
                                               <div className="match-bo5-label">BO5</div>
                                            </div>
                                            {round < totalRounds && (
                                               <>
                                                  {/* Line from card to center */}
                                                  <div className="match-connector-line !bg-fuchsia-500/60" style={{ right: '-40px', width: '40px' }} />
                                                  
                                                  {/* Vertical branch line */}
                                                  <div 
                                                    className="bracket-vertical-line !bg-fuchsia-500/60" 
                                                    style={{ 
                                                       height: `${vLineHeight}px`, 
                                                       right: '-40px',
                                                       top: match.order % 2 === 0 ? '50%' : 'auto', 
                                                       bottom: match.order % 2 !== 0 ? '50%' : 'auto' 
                                                    }} 
                                                  />

                                                  {/* Horizontal bridge to next round */}
                                                  {match.order % 2 === 0 && (
                                                     <div 
                                                       className="bracket-line-meeting !bg-fuchsia-500/60" 
                                                       style={{ 
                                                          top: `calc(50% + ${vLineHeight}px)`,
                                                          right: '-80px',
                                                          width: '40px'
                                                       }}
                                                     />
                                                  )}
                                               </>
                                            )}
                                         </div>
                                       );
                                    })}
                                 </div>
                              );
                          })}
                       </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {activeTab === 'clans' && (
              <div className="space-y-4" ref={dropdownRef}>
                {registrations.length === 0 ? (<div className="flex items-center justify-center h-48 text-gray-500 font-bold uppercase tracking-wider">Chưa có đội nào đăng ký</div>) : (
                    <div className="grid grid-cols-1 md:grid-cols-1 gap-4">{registrations.map((reg) => (<div key={reg.id} className="flex items-center justify-between p-4 bg-neutral-900 border border-white/5 rounded-lg group hover:border-fuchsia-500/30 transition-all"><div className="flex items-center gap-4"><div className="w-12 h-12 bg-neutral-800 rounded-full flex items-center justify-center border border-white/5 relative overflow-hidden"><div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent"></div><ClanIconDisplay iconName={reg.clans.icon || 'Shield'} color={reg.clans.color || '#d946ef'} className="w-6 h-6 transform group-hover:scale-110 transition-transform duration-300" /></div><div><div className="flex items-center gap-2"><span className="text-xs font-black text-fuchsia-500 uppercase tracking-wider px-1.5 py-0.5 bg-fuchsia-500/10 rounded border border-fuchsia-500/20">[{reg.clans.tag}]</span><h4 className="text-white font-bold leading-none">{reg.clans.name}</h4></div><div className="flex items-center gap-2 mt-1.5"><div className={`w-1.5 h-1.5 rounded-full ${['confirmed', 'approved'].includes(reg.status) ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`}></div><span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">{['confirmed', 'approved'].includes(reg.status) ? 'Đã xác nhận' : 'Đang chờ duyệt'}</span></div></div></div><div className="relative"><button onClick={(e) => toggleDropdown(reg.id, e)} className="p-2 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors outline-none"><MoreVertical size={18} className="translate-y-[1px]" /></button>{openDropdownId === reg.id && (<div className="absolute right-0 top-full mt-2 w-48 bg-neutral-900 border border-white/10 rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.5)] z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top-right"><div className="p-1"><button onClick={() => handleViewClanDetails(reg.clan_id)} className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors text-left"><Eye size={14} />Xem chi tiết Clan</button></div></div>)}</div></div>))}</div>
                )}
              </div>
            )}

             {activeTab === 'match' && (
               <div className="space-y-4">
                 {phase === 'waiting' && (
                    <div className="flex flex-col items-center justify-center h-80 border border-white/5 bg-black/40 rounded-2xl relative overflow-hidden group">
                      <div className="absolute inset-0 bg-dot-pattern opacity-5" />
                      <div className="p-6 bg-fuchsia-500/20 rounded-full mb-6 relative">
                        <Swords size={48} className="text-fuchsia-500/30 animate-pulse" />
                      </div>
                      <h3 className="text-xl font-black text-white uppercase tracking-tighter italic mb-2">Danh sách trận đấu</h3>
                      <p className="text-gray-500 text-xs font-bold uppercase tracking-widest text-center max-w-xs">Các trận đấu sẽ xuất hiện khi giải đấu bắt đầu (Lúc {TOURNAMENT_CONFIG.DISPLAY_TIME})</p>
                    </div>
                 )}

                 {phase === 'shuffling' && (
                    <div className="flex flex-col items-center justify-center h-[400px] border border-fuchsia-500/20 bg-fuchsia-950/5 rounded-2xl relative overflow-hidden">
                      <div className="absolute inset-0 bg-scanline-fast opacity-10" />
                      <div className="relative z-10 flex flex-col items-center">
                        <div className="w-24 h-24 relative mb-8">
                          <Loader2 size={96} className="text-fuchsia-500 animate-spin opacity-50 absolute inset-0" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Trophy size={32} className="text-white animate-bounce" />
                          </div>
                        </div>
                        <h3 className="text-2xl font-black text-white uppercase italic tracking-tighter mb-4 animate-pulse">Đang xáo trộn bắt cặp...</h3>
                        <div className="flex gap-2">
                          {[1, 2, 3].map(i => (
                            <div key={i} className="w-2 h-2 bg-fuchsia-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.2}s` }} />
                          ))}
                        </div>
                        <p className="mt-8 text-[10px] font-black text-fuchsia-500 uppercase tracking-[0.3em] italic">Vui lòng chờ trong {timeLeft} giây</p>
                      </div>
                    </div>
                 )}

                 {(phase === 'preparation' || phase === 'live' || phase === 'completed') && (
                   matches.filter(m => m.clan1 || m.clan2).length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-80 border border-white/5 bg-black/40 rounded-2xl relative overflow-hidden group">
                        <div className="absolute inset-0 bg-dot-pattern opacity-5" />
                        <div className="p-6 bg-fuchsia-500/20 rounded-full mb-6 relative">
                           <Swords size={48} className="text-fuchsia-500/30 animate-pulse" />
                        </div>
                        <h3 className="text-xl font-black text-white uppercase tracking-tighter italic mb-2">Chưa có trận đấu nào</h3>
                        <p className="text-gray-500 text-xs font-bold uppercase tracking-widest text-center max-w-xs">Đang cập nhật dữ liệu...</p>
                      </div>
                   ) : (
                     <div className="grid grid-cols-1 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
                       {matches
                         .filter(m => m.clan1 || m.clan2)
                       .sort((a, b) => {
                         // Sorting priority: live > initial/waiting > completed
                         const getPriority = (m: Match) => {
                           if (m.status === 'live') return 0;
                           if (m.status === 'completed') return 2;
                           return 1; // 'waiting' or undefined
                         };
                         const pA = getPriority(a);
                         const pB = getPriority(b);
                         if (pA !== pB) return pA - pB;
                         // Same priority: sort by time
                         return new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime();
                       })
                       .map((match) => {
                         const matchDate = new Date(match.scheduledTime);
                         const isLive = match.status === 'live';
                         const isCompleted = match.status === 'completed';
                         const totalRounds = Math.log2(Math.pow(2, Math.ceil(Math.log2(registrations.length || 16))));
                         
                         // Match timer for live matches
                         let elapsedStr = "";
                         if (isLive) {
                            const diff = Math.floor((currentTime - matchDate.getTime()) / 1000);
                            const mins = Math.floor(diff / 60);
                            const secs = diff % 60;
                            elapsedStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                         }

                         return (
                           <div key={match.id} className={`p-5 bg-neutral-900 border ${isLive ? 'border-fuchsia-500 shadow-[0_0_20px_rgba(192,38,211,0.2)]' : 'border-white/5'} rounded-xl group transition-all hover:bg-neutral-800/80`}>
                             <div className="flex items-center justify-between mb-6">
                               <div className="flex items-center gap-3">
                                 <div className="px-2.5 py-1 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-md">
                                    <span className="text-[10px] font-black text-fuchsia-500 uppercase tracking-widest">
                                      {match.round === totalRounds ? 'Chung kết' : match.round === totalRounds - 1 ? 'Bán kết' : `Vòng ${match.round}`}
                                    </span>
                                 </div>
                                 {isLive && (
                                   <div className="flex items-center gap-2 px-2.5 py-1 bg-red-500/10 border border-red-500/20 rounded-md animate-pulse">
                                     <div className="w-1.5 h-1.5 bg-red-500 rounded-full shadow-[0_0_5px_#ef4444]" />
                                     <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">LIVE {elapsedStr}</span>
                                   </div>
                                 )}
                                 {isCompleted && (
                                   <div className="px-2.5 py-1 bg-green-500/10 border border-green-500/20 rounded-md">
                                     <span className="text-[10px] font-black text-green-500 uppercase tracking-widest">Kết thúc</span>
                                   </div>
                                 )}
                               </div>
                               <div className="flex items-center gap-2 px-3 py-1 bg-black/40 rounded-full border border-white/5">
                                 <Clock size={12} className="text-fuchsia-500" />
                                 <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                   {matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                                 </span>
                               </div>
                             </div>

                             <div className="flex items-center justify-between gap-6 relative">
                               {/* Team 1 */}
                               <div className="flex-1 flex items-center justify-end gap-4 text-right">
                                 <div className="flex flex-col items-end">
                                   <span className={`text-sm md:text-base font-black uppercase italic tracking-tighter transition-colors ${match.winnerId === match.clan1?.id ? 'text-white' : isCompleted ? 'text-gray-600' : 'text-gray-300'}`}>
                                     {match.clan1?.name || 'TBD'}
                                   </span>
                                   <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${match.clan1 ? 'text-fuchsia-500' : 'text-gray-700'}`}>
                                     [{match.clan1?.tag || '---'}]
                                   </span>
                                 </div>
                                 <div className={`w-12 h-12 rounded-xl flex items-center justify-center border transition-all ${match.winnerId === match.clan1?.id ? 'bg-fuchsia-500/20 border-fuchsia-500 shadow-[0_0_15px_rgba(192,38,211,0.2)]' : 'bg-neutral-800 border-white/10'}`}>
                                   {match.clan1 ? <ClanIconDisplay iconName={match.clan1.icon || 'Shield'} color={match.clan1.color || '#fff'} className="w-6 h-6" /> : <Users size={24} className="text-neutral-700" />}
                                 </div>
                               </div>

                               {/* VS / Score Divider */}
                               <div className="flex flex-col items-center gap-2">
                                 <div className="flex items-center gap-4">
                                     <span className={`text-2xl font-black italic ${isLive ? 'text-white' : isCompleted ? 'text-gray-400' : 'text-gray-800'}`}>
                                         {match.score1 ?? 0}
                                     </span>
                                     <div className="w-8 h-8 rounded-full bg-black border border-white/10 flex items-center justify-center relative z-10">
                                       <span className="text-[10px] font-black text-fuchsia-500 italic">VS</span>
                                     </div>
                                     <span className={`text-2xl font-black italic ${isLive ? 'text-white' : isCompleted ? 'text-gray-400' : 'text-gray-800'}`}>
                                         {match.score2 ?? 0}
                                     </span>
                                 </div>
                                 <div className="px-2 py-0.5 bg-neutral-800 border border-white/5 rounded text-[8px] font-black text-gray-500 tracking-[0.2em]">BO5</div>
                               </div>

                               {/* Team 2 */}
                               <div className="flex-1 flex items-center gap-4">
                                 <div className={`w-12 h-12 rounded-xl flex items-center justify-center border transition-all ${match.winnerId === match.clan2?.id ? 'bg-fuchsia-500/20 border-fuchsia-500 shadow-[0_0_15px_rgba(192,38,211,0.2)]' : 'bg-neutral-800 border-white/10'}`}>
                                   {match.clan2 ? <ClanIconDisplay iconName={match.clan2.icon || 'Shield'} color={match.clan2.color || '#fff'} className="w-6 h-6" /> : match.round === 1 && match.clan1 ? <Zap size={24} className="text-fuchsia-500/40" /> : <Users size={24} className="text-neutral-700" />}
                                 </div>
                                 <div className="flex flex-col">
                                   <span className={`text-sm md:text-base font-black uppercase italic tracking-tighter transition-colors ${match.winnerId === match.clan2?.id ? 'text-white' : isCompleted ? 'text-gray-600' : 'text-gray-300'}`}>
                                     {match.clan2?.name || (match.round === 1 && match.clan1 ? 'BYE (Đặc cách)' : 'TBD')}
                                   </span>
                                   <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${match.clan2 ? 'text-fuchsia-500' : 'text-gray-700'}`}>
                                     [{match.clan2?.tag || '---'}]
                                   </span>
                                 </div>
                               </div>

                               {/* Winner Indicator */}
                               {isCompleted && match.round === totalRounds && (
                                 <div className={`absolute top-[-20px] ${match.winnerId === match.clan1?.id ? 'left-0' : 'right-0'} animate-bounce`}>
                                   <Trophy size={16} className="text-yellow-500" />
                                 </div>
                               )}
                             </div>
                           </div>
                         );
                       })}
                     </div>
                   )
                 )}
               </div>
             )}

              </>
            )}
          </div>
        </div>
        <div className="space-y-6">
          <div className="p-6 bg-fuchsia-900/10 border border-fuchsia-500/20 rounded-xl relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
            <div className="relative z-10">
              <h3 className="text-sm font-black text-white uppercase tracking-widest mb-6 border-b border-fuchsia-500/30 pb-3">Thông tin đăng ký</h3>
              {isFetchingRegs ? (
                <div className="space-y-4 mb-8">
                  <div className="flex justify-between items-center"><SkeletonBox className="h-4 w-16" /><SkeletonBox className="h-4 w-20" /></div>
                  <div className="flex justify-between items-center"><SkeletonBox className="h-4 w-32" /><SkeletonBox className="h-8 w-24" /></div>
                  <div className="flex justify-between items-center"><SkeletonBox className="h-4 w-16" /><SkeletonBox className="h-4 w-24" /></div>
                </div>
              ) : (
                <div className="space-y-4 mb-8">
                  <div className="flex justify-between items-center text-sm"><span className="text-gray-500 font-bold">Lệ phí</span><span className="flex items-center gap-1 text-white font-black">{currentData.entry_fee} <Coins size={14} className="text-yellow-500" /></span></div>
                  <div className="flex justify-between items-center text-sm"><span className="text-gray-500 font-bold">Ngày kết thúc đăng ký</span><div className="text-right"><div className="text-white font-black">{TOURNAMENT_CONFIG.REG_END_DATE}</div><div className="text-[10px] text-fuchsia-500 font-bold">{TOURNAMENT_CONFIG.REG_END_TIME} GMT+7</div></div></div>
                  <div className="flex justify-between items-center text-sm"><span className="text-gray-500 font-bold">Chế độ</span><span className="text-white font-black">{currentData.tournament_type} Clan</span></div>
                </div>
              )}
              <button onClick={handleRegisterClick} disabled={isFull || isRegistered || isRegistering || isFetchingRegs} className={`w-full py-4 text-xs font-black uppercase tracking-[0.2em] transition-all shadow-lg flex items-center justify-center gap-2 ${isFull || isRegistered || isFetchingRegs ? 'bg-neutral-800 text-gray-500 cursor-not-allowed border border-white/5' : 'bg-fuchsia-600 hover:bg-fuchsia-500 text-white group-hover:shadow-[0_0_20px_rgba(192,38,211,0.4)]'}`}>
                {isRegistering ? <Loader2 className="animate-spin" size={16} /> : 
                 isFetchingRegs ? <span className="flex items-center gap-2"><Loader2 className="animate-spin" size={14} /> LOADING...</span> :
                 isRegistered ? 'Đã đăng ký' : 
                 isFull ? 'Đã đóng (Full)' : 
                 <>{'Đăng ký ngay'} <ChevronRight size={16} /></>}
              </button>
            </div>
          </div>    
          <div className="p-6 bg-neutral-900 border border-white/5 rounded-xl"><h3 className="text-sm font-black text-white uppercase tracking-widest mb-6 border-b border-white/10 pb-3">Tin tức liên quan</h3><div className="space-y-4">{[1, 2].map(i => (<div key={i} className="group cursor-pointer"><span className="text-[10px] text-fuchsia-500 font-bold uppercase mb-1 block">Tin tức</span><h4 className="text-sm font-bold text-gray-300 group-hover:text-white transition-colors leading-tight mb-2">Cập nhật thay đổi luật thi đấu mùa giải 2025</h4><span className="text-[10px] text-gray-600 flex items-center gap-2"><Clock size={10} /> 2 giờ trước</span></div>))}</div></div>
        </div>
      </div>

      {showConfirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-in fade-in duration-200"><div className="bg-neutral-900 border border-fuchsia-500/30 rounded-2xl max-w-md w-full p-8 shadow-[0_0_50px_rgba(192,38,211,0.2)] md:p-10 relative overflow-hidden"><div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-fuchsia-600 to-blue-600" /><div className="flex flex-col items-center text-center space-y-6"><div className="w-20 h-20 bg-fuchsia-500/20 rounded-full flex items-center justify-center border border-fuchsia-500/20 mb-2"><Trophy size={40} className="text-fuchsia-500" /></div><div className="space-y-2"><h3 className="text-2xl font-black text-white uppercase italic tracking-tighter">Xác nhận Đăng ký?</h3><p className="text-gray-400 text-sm font-bold leading-relaxed px-4">Bạn đang đăng ký tham gia <span className="text-white">{currentData.title}</span> với tư cách là <span className="text-fuchsia-500">Trưởng Clan</span>.</p><p className="text-xs text-fuchsia-400 font-bold bg-fuchsia-500/20 py-2 px-4 rounded-lg mt-2 inline-block border border-fuchsia-500/10">Phí tham dự: {currentData.entry_fee} <Coins size={12} className="inline text-yellow-500" /></p></div><div className="flex gap-4 w-full pt-4"><button onClick={() => setShowConfirmModal(false)} className="flex-1 py-4 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white font-black uppercase tracking-widest text-xs rounded-xl border border-white/5 transition-all">Hủy bỏ</button><button onClick={handleConfirmRegistration} disabled={isRegistering} className="flex-1 py-4 bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-black uppercase tracking-widest text-xs rounded-xl shadow-lg hover:shadow-fuchsia-500/25 transition-all active:scale-95 flex items-center justify-center gap-2">{isRegistering && <Loader2 className="animate-spin" size={16} />}Xác nhận</button></div></div></div></div>
      )}

      {showErrorModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-in fade-in duration-200"><div className="bg-neutral-900 border border-red-500/30 rounded-2xl max-w-md w-full p-8 shadow-[0_0_50px_rgba(239,68,68,0.2)] md:p-10 relative overflow-hidden"><div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-600 to-orange-600" /><div className="flex flex-col items-center text-center space-y-6"><div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center border border-red-500/20 mb-2"><AlertTriangle size={40} className="text-red-500" /></div><div className="space-y-2"><h3 className="text-2xl font-black text-white uppercase italic tracking-tighter">{errorType === 'role' ? 'Quyền hạn bị từ chối' : errorType === 'no-clan' ? 'Chưa tham gia Clan' : 'Số lượng thành viên không đủ'}</h3><p className="text-gray-400 text-sm font-bold leading-relaxed px-2">{errorType === 'role' ? 'Chỉ Trưởng Clan (Leader) mới có quyền đăng ký tham gia giải đấu này.' : errorType === 'no-clan' ? 'Bạn cần gia nhập hoặc tạo một Clan để tham gia giải đấu.' : 'Clan của bạn cần có đủ 5 thành viên để đăng ký tham gia giải đấu này.'}</p>{errorType !== 'member-count' && (<p className="text-xs text-red-400 font-bold mt-2">Việc vắng mặt khi đã đăng ký sẽ bị xử thua.</p>)}</div><button onClick={() => setShowErrorModal(false)} className="w-full py-4 bg-white/5 hover:bg-white/10 text-white font-black uppercase tracking-widest text-xs rounded-xl border border-white/5 transition-all mt-4">Đã hiểu</button></div></div></div>
      )}

      {toast && ( <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} /> )}
    </div>
  );
};

export default TournamentDetailView;
