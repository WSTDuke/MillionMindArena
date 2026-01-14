import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Clock, Swords, Shield, ArrowLeft } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { TOURNAMENT_CONFIG } from '../../lib/constants';
import { getRankFromMMR } from '../../lib/ranking';
import { CLAN_ICONS } from './clanConstants';

interface MatchMember {
  id: string;
  name: string;
  avatar?: string;
  rank: string;
  rankColor: string;
}

interface ClanInfo {
  id: string;
  name: string;
  tag: string;
  icon: string;
  color: string;
}

// --- Reused Components ---

const ClanIconDisplay = ({ iconName, color, className = "w-12 h-12" }: { iconName: string, color: string, className?: string }) => {
  const iconObj = CLAN_ICONS.find(item => item.id === iconName);
  const IconComponent = iconObj ? iconObj.icon : Shield;
  return <IconComponent className={className} style={{ color: color }} />;
};

const PlayerCard = ({ player, side }: { player: MatchMember, side: 'left' | 'right' }) => (
  <div className={`relative w-full h-40 md:h-56 bg-zinc-950 border border-white/5 overflow-hidden group transition-all duration-300 hover:border-fuchsia-500/40 hover:shadow-[0_0_20px_rgba(217,70,239,0.15)]`}>
    {/* Avatar Background - No Blur */}
    <div className="absolute inset-0 z-0">
      <img 
        src={player.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${player.id}`} 
        alt={player.name} 
        className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />
      
      {/* Subtle Pattern Overlay */}
      <div className="absolute inset-0 opacity-[0.15] bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] mix-blend-overlay" />
    </div>

    {/* Header Accent Line */}
    <div 
        className={`absolute top-0 left-0 w-full h-0.5 opacity-50 group-hover:opacity-100 transition-opacity`}
        style={{ backgroundColor: side === 'left' ? '#d946ef' : '#3b82f6' }}
    />

    {/* Info Overlay */}
    <div className="absolute inset-x-0 bottom-0 z-20 p-3 pt-8 bg-gradient-to-t from-black via-black/80 to-transparent flex flex-col justify-end transition-transform duration-300 group-hover:translate-y-[-2px]">
        <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 opacity-60">
                <span className="text-[7px] font-black text-white uppercase tracking-[0.3em]">Player</span>
                <div className="h-px flex-1 bg-white/20" />
            </div>
            <h4 className="text-sm md:text-base font-black text-white uppercase italic tracking-tighter truncate drop-shadow-lg">
                {player.name}
            </h4>
            <div 
               className="inline-flex items-center justify-center mt-1.5 px-2.5 py-0.5 border border-white/10 bg-zinc-900/90 w-full "
               style={{ borderBottomColor: player.rankColor, borderBottomWidth: '3px' }}
            >
                <span className="text-[9px] font-black uppercase tracking-widest" style={{ color: player.rankColor }}>
                    {player.rank}
                </span>
            </div>
        </div>
    </div>

    {/* Side Glow Line */}
    <div 
        className={`absolute bottom-0 left-0 w-full h-1 shadow-[0_-4px_12px_rgba(0,0,0,0.5)]`}
        style={{ backgroundColor: side === 'left' ? '#d946ef' : '#3b82f6' }}
    />
  </div>
);

const TournamentMatchView = () => {
    const { matchId } = useParams();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [timeLeft, setTimeLeft] = useState(30);

    const [matchData, setMatchData] = useState<{
        clan1: ClanInfo;
        clan2: ClanInfo | null;
        members1: MatchMember[];
        members2: MatchMember[];
        matchTime: string;
    } | null>(null);

    const fetchClanMembers = useCallback(async (clanId: string): Promise<MatchMember[]> => {
      try {
        // 1. Fetch clan members first
        const { data: members, error: memberError } = await supabase
          .from('clan_members')
          .select('user_id')
          .eq('clan_id', clanId)
          .eq('status', 'approved')
          .limit(5);
  
        if (memberError) throw memberError;
        if (!members || members.length === 0) return [];
  
        const userIds = members.map(m => m.user_id);
  
        // 2. Fetch profiles
        const { data: profiles, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url, mmr')
          .in('id', userIds);
  
        if (profileError) throw profileError;
  
        return members.map(m => {
          const prof = profiles?.find(p => p.id === m.user_id);
          const rankInfo = getRankFromMMR(prof?.mmr || 0);
          return {
            id: prof?.id || m.user_id,
            name: prof?.display_name || 'Chiến Binh',
            avatar: prof?.avatar_url || undefined,
            rank: `${rankInfo.tier} ${rankInfo.division}`,
            rankColor: rankInfo.color
          };
        });
      } catch (err) {
        console.error('Error fetching clan members:', err);
        return [];
      }
    }, []);

    useEffect(() => {
        const loadMatchData = async () => {
            if (!matchId) return;

            const storageKey = `bracket_${TOURNAMENT_CONFIG.ID}_${TOURNAMENT_CONFIG.START_TIME}`;
            const savedBracketStr = localStorage.getItem(storageKey);
            
            if (!savedBracketStr) {
                 setLoading(false);
                 return;
            }

            interface BracketMatch {
                id: string;
                clan1: ClanInfo;
                clan2: ClanInfo | null;
                status: string;
                scheduledTime: string;
            }
            const matches: BracketMatch[] = JSON.parse(savedBracketStr);
            const myMatch = matches.find((m) => m.id === matchId);

            if (!myMatch) {
                setLoading(false);
                return;
            }

            // We need to figure out which is clan1 and clan2. 
            // In MatchMonitor, we checked userClanId to orient "me" vs "opponent".
            // Here we don't strictly have userClanId passed, but we can just use the match order.
            // Or better, let's just display them as is. 
            // But MatchMonitor logic: 
            // const isClan1User = myMatch.clan1?.id === userClanId;
            // const userClan = isClan1User ? myMatch.clan1 : myMatch.clan2;
            // const opponentClan = isClan1User ? myMatch.clan2 : myMatch.clan1;
            
            // Here, we can just display Clan 1 (Left) and Clan 2 (Right) as they appear in the match object.
            
            const clan1 = myMatch.clan1;
            const clan2 = myMatch.clan2;

            if (!clan1) {
                 setLoading(false);
                 return;
            }

            const [m1, m2] = await Promise.all([
                 fetchClanMembers(clan1.id),
                 clan2 ? fetchClanMembers(clan2.id) : Promise.resolve([])
            ]);

            setMatchData({
                clan1,
                clan2,
                members1: m1,
                members2: m2,
                matchTime: new Date(myMatch.scheduledTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            });
            setLoading(false);
        };

        loadMatchData();
    }, [matchId, fetchClanMembers]);

    // Timer Logic
    useEffect(() => {
        const timer = setInterval(() => {
            setTimeLeft((prev) => {
                if (prev <= 0) {
                    clearInterval(timer);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    // Navigation when timer hits 0
    useEffect(() => {
        if (timeLeft === 0 && matchData) {
            navigate('/gameplay?mode=tournament', { 
                state: { 
                    tournamentMatchData: matchData,
                    isTournament: true
                } 
            });
        }
    }, [timeLeft, matchData, navigate]);

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center bg-black">
  <div className="flex flex-col items-center gap-4">

    {/* Text chính */}
    <p className="text-3xl font-black tracking-widest uppercase
                   text-fuchsia-400
                   animate-pulse
                   drop-shadow-[0_0_15px_#d946ef]">
      ĐANG TẢI
    </p>

    {/* Dấu chấm nhấp nháy */}
    <div className="flex gap-2 text-fuchsia-400 text-3xl font-black">
      <span className="animate-bounce [animation-delay:0ms]">.</span>
      <span className="animate-bounce [animation-delay:200ms]">.</span>
      <span className="animate-bounce [animation-delay:400ms]">.</span>
    </div>

    {/* Subtitle */}
    <p className="text-xs uppercase tracking-[0.4em] text-fuchsia-300/60 animate-pulse">
      Vui lòng chờ
    </p>

  </div>
</div>
;
    }

    if (!matchData) {
         return <div className="min-h-screen bg-black flex items-center justify-center text-white">Match not found</div>;
    }

    const { clan1, clan2, members1, members2, matchTime } = matchData;

    return (
        <div className="h-screen w-full bg-black animate-in fade-in duration-700 overflow-hidden flex flex-col font-sans relative">
          {/* Cinematic Background */}
          <div className="absolute inset-0 z-0">
            <img 
               src="/tournament_bg.png" 
               alt="Arena Background" 
               className="w-full h-full object-cover opacity-60 scale-105 animate-pulse-slow"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/60" />
            <div className="absolute inset-0 bg-fuchsia-950/20 mix-blend-overlay" />
          </div>
    
          {/* Background Decor */}
          <div className="absolute inset-0 pointer-events-none z-[1]">
            <div className="absolute top-0 left-0 w-1/2 h-full bg-fuchsia-900/10 blur-[120px]" />
            <div className="absolute bottom-0 right-0 w-1/2 h-full bg-blue-900/10 blur-[120px]" />
            <div className="absolute inset-0 bg-dot-pattern opacity-10" />
          </div>
    
          {/* Header Info */}
          <div className="relative z-10 px-8 py-6 flex flex-col items-center shrink-0">
             <div className="flex items-center gap-3 mb-2">
                <div className="px-3 py-1 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded">
                    <span className="text-xs font-black text-fuchsia-500 uppercase tracking-[0.3em]">Cặp Đấu Đang Khởi Tranh</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded">
                    <Clock size={14} className="text-blue-500" />
                    <span className="text-xs font-black text-white italic">{matchTime}</span>
                </div>
             </div>
             <h2 className="text-2xl md:text-3xl font-black text-white uppercase italic tracking-tighter">
                Kiểm tra <span className="text-fuchsia-500">Đối Thủ</span>
             </h2>
          </div>
    
          {/* Main Content Area */}
          <div className="flex-1 relative z-10 px-4 md:px-8 flex flex-col xl:flex-row items-center justify-between gap-4 md:gap-6 w-full max-w-[1700px] mx-auto min-h-0 overflow-y-auto custom-scrollbar py-4">
            {/* Team 1 (Left) */}
            <div className="flex-[2] flex flex-col items-center justify-center space-y-6 animate-in slide-in-from-left-8 duration-700 h-full min-w-0">
               <div className="flex flex-col items-center gap-4 shrink-0">
                  <div className="p-4 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl relative group">
                    <div className="absolute -inset-2 bg-gradient-to-br from-fuchsia-600 to-transparent opacity-20 blur-xl group-hover:opacity-40 transition-opacity" />
                    <ClanIconDisplay iconName={clan1.icon} color={clan1.color} className="w-16 h-16 md:w-20 md:h-20" />
                  </div>
                  <div className="text-center">
                     <h3 className="text-2xl md:text-4xl font-black text-white italic uppercase tracking-tighter">
                       {clan1.name}
                     </h3>
                     <span className="text-sm font-black text-fuchsia-500 uppercase tracking-[0.3em]">[{clan1.tag}]</span>
                  </div>
               </div>
    
               <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 w-full">
                  {members1.map((p, idx) => (
                    <div key={p.id} className="animate-in fade-in slide-in-from-bottom-4" style={{ animationDelay: `${idx * 0.1}s` }}>
                       <PlayerCard player={p} side="left" />
                    </div>
                  ))}
               </div>
            </div>
    
            {/* Center VS & Timer */}
            <div className="flex-none flex flex-col items-center justify-center space-y-6 py-4 min-w-[140px] shrink-0">
               <div className="relative group">
                  <div className="absolute animate-ping -inset-4 bg-white/5 rounded-full blur-2xl" />
                  <div className="w-20 h-20 md:w-24 md:h-24 rounded-full bg-white border-2 border-fuchsia-500 flex items-center justify-center relative">
                     <span className="text-3xl md:text-5xl font-black text-black italic italic-extreme tracking-tight">VS</span>
                  </div>
               </div>
    
               <div className="flex flex-col items-center gap-2">
                  <span className="text-[10px] font-black text-gray-500 uppercase tracking-[0.4em]">Bắt đầu sau</span>
                  <div className="text-5xl font-black text-white tabular-nums italic">
                     {timeLeft.toString().padStart(2, '0')}
                  </div>
                  <div className="w-16 h-1 bg-white/10 rounded-full overflow-hidden">
                     <div 
                        className="h-full bg-fuchsia-500 transition-all duration-1000 ease-linear"
                        style={{ width: `${(timeLeft / 30) * 100}%` }}
                     />
                  </div>
               </div>
            </div>
    
            {/* Team 2 (Right) */}
            <div className="flex-[2] flex flex-col items-center justify-center space-y-6 animate-in slide-in-from-right-8 duration-700 h-full min-w-0">
               <div className="flex flex-col items-center gap-4 shrink-0">
                  <div className="p-4 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl relative group">
                    <div className="absolute -inset-2 bg-gradient-to-br from-blue-600 to-transparent opacity-20 blur-xl group-hover:opacity-40 transition-opacity" />
                    {clan2 ? (
                        <ClanIconDisplay iconName={clan2.icon} color={clan2.color} className="w-16 h-16 md:w-20 md:h-20" />
                    ) : (
                        <Swords className="w-16 h-16 md:w-20 md:h-20 text-neutral-800" />
                    )}
                  </div>
                  <div className="text-center">
                     <h3 className="text-2xl md:text-4xl font-black text-white italic uppercase tracking-tighter">
                       {clan2?.name || "ĐANG CHỜ..."}
                     </h3>
                     <span className="text-sm font-black text-blue-500 uppercase tracking-[0.3em]">[{clan2?.tag || "???"}]</span>
                  </div>
               </div>
    
               <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 w-full">
                  {members2.length > 0 ? members2.map((p, idx) => (
                    <div key={p.id} className="animate-in fade-in slide-in-from-bottom-4" style={{ animationDelay: `${idx * 0.1}s` }}>
                       <PlayerCard player={p} side="right" />
                    </div>
                  )) : Array.from({ length: 5 }).map((_, idx) => (
                    <div key={idx} className="w-full h-40 md:h-56 bg-neutral-900/40 border border-white/5 rounded-xl animate-pulse" />
                  ))}
               </div>
            </div>
          </div>
    
          {/* Cyber Overlays */}
          <div className="absolute inset-0 pointer-events-none opacity-10">
             <div className="w-full h-full bg-scanline animate-scanline" />
          </div>
          <div className="absolute top-0 left-0 w-full h-[1px] bg-white/20" />
          <div className="absolute bottom-0 left-0 w-full h-[1px] bg-white/20" />
        </div>
      );
};

export default TournamentMatchView;
