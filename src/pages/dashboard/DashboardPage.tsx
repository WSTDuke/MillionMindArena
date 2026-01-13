import { useRef, useState, useEffect, type ElementType } from "react";
import { useNavigate, NavLink, Outlet, Link, useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { getRankFromMMR } from "../../lib/ranking";
import {
  LayoutDashboard,
  Trophy,
  Swords,
  Settings,
  Search,
  LogOut,
  Users,
  ChevronRight,
  Loader2,
  Shield,
  User,
  Coins,
  Plus,
} from "lucide-react";
import Toast, { type ToastType } from "../../components/Toast";

import MatchMonitor from "./components/MatchMonitor";


interface PlayerResult {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
  mmr: number | null;
}

const DashboardPage = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<import('@supabase/supabase-js').User | null>(null); // From Supabase Auth
  const [profile, setProfile] = useState<{ id: string; display_name: string | null; avatar_url: string | null; mmr: number | null; balance?: number } | null>(null); // From profiles table
  const [dashboardCache, setDashboardCache] = useState<Record<string, any>>({});
  const [toast, setToast] = useState<{ message: React.ReactNode; type: ToastType; visible: boolean }>({ message: "", type: "success", visible: false });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlayerResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const mainContentRef = useRef<HTMLElement>(null);



  const location = useLocation();

  // Scroll to top on route change
  useEffect(() => {
    if (mainContentRef.current) {
      mainContentRef.current.scrollTop = 0;
    }
  }, [location.pathname]);

  useEffect(() => {


    const getClanData = async (userId: string) => {
      console.log('[DashboardPage] Fetching clan data for user:', userId);
      // 1. Check membership
      const { data: memberData, error: memberError } = await supabase
        .from('clan_members')
        .select('clan_id, status, role')
        .eq('user_id', userId);

      if (memberError) {
        console.error("[DashboardPage] Error fetching clan members:", memberError);
        return;
      }

      console.log('[DashboardPage] Member data:', memberData);

      if (memberData && memberData.length > 0) {
        const approvedMember = memberData.find(m => m.status === 'approved');
        console.log('[DashboardPage] Approved member:', approvedMember);
        
        const statusMap: { [key: string]: 'pending' | 'member' } = {};
        
        memberData.forEach(m => {
          if (m.status === 'approved' || m.status === 'pending') {
            statusMap[m.clan_id] = m.status;
          }
        });

        // 2. If approved member, fetch clan details
        let clanInfo = null;
        if (approvedMember) {
           const { data: clanDetails, error: clanError } = await supabase
            .from('clans')
            .select('*')
            .eq('id', approvedMember.clan_id)
            .single();
            
           if (!clanError && clanDetails) {
             clanInfo = {
               ...clanDetails,
               role: approvedMember.role
             };
             console.log('[DashboardPage] Clan info loaded:', clanInfo);
           } else {
             console.error('[DashboardPage] Error fetching clan details:', clanError);
           }
        } else {
          console.log('[DashboardPage] No approved member found');
        }

        setDashboardCache(prev => ({
          ...prev,
          userClanStatus: statusMap,
          clanInfo: clanInfo
        }));
      } else {
        console.log('[DashboardPage] No clan membership found');
      }
    };

    const initData = async () => {
       const { data: { user } } = await supabase.auth.getUser();
       setUser(user);

       if (user) {
         // Parallel fetch for profile and clan data
         await Promise.all([
           (async () => {
             const { data } = await supabase
               .from("profiles")
               .select("*")
               .eq("id", user.id)
               .single();
             setProfile(data);
           })(),
           getClanData(user.id)
         ]);
       }
    };

    initData();
  }, []);

  // --- SEARCH LOGIC ---
  useEffect(() => {
    const searchPlayers = async () => {
      const trimmedQuery = searchQuery.trim();

      // Rule: Min length 3
      if (trimmedQuery.length < 3) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      // Rule: Numeric-only query must be >= 5 chars to avoid "random ID" noise
      const isNumeric = /^\d+$/.test(trimmedQuery);
      if (isNumeric && trimmedQuery.length < 5) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      try {
        // Prefix Search (query%) for both Email and Display Name
        const { data, error } = await supabase
          .from("profiles")
          .select("id, display_name, avatar_url, email, mmr")
          .or(`email.ilike.${trimmedQuery}%,display_name.ilike.${trimmedQuery}%`)
          .limit(5);

        if (!error && data) {
          setSearchResults(data);
        }
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setIsSearching(false);
      }
    };

    const timer = setTimeout(searchPlayers, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Close search results on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearchResults(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  const showToast = (message: React.ReactNode, type: ToastType = 'success') => {
    setToast({ message, type, visible: true });
  };

  const rankInfo = getRankFromMMR(profile?.mmr ?? 0);

  return (
    <div className="flex h-screen bg-black text-white font-sans overflow-hidden">
      {/* Background Monitor for Tournament Matches */}
      <MatchMonitor 
        userClanId={dashboardCache?.clanInfo?.id}
      />

      {/* Sidebar */}
      <aside className="w-20 md:w-64 bg-neutral-900 border-r border-white/5 flex flex-col z-50">
        <div className="p-6 flex items-center gap-3">
          <span className="hidden md:block font-black text-xl tracking-tighter uppercase">
            MillionMind <span className="text-fuchsia-500">ARENA</span>
          </span>
        </div>

        <nav className="flex-1 px-4 space-y-2 py-6">
          <NavItem
            icon={LayoutDashboard}
            label="Tổng quan"
            to="/dashboard"
          />
          <NavItem
            icon={Swords}
            label="Đấu trường"
            to="/dashboard/arena"
          />
          <NavItem
            icon={Trophy}
            label="Giải đấu"
            to="/dashboard/tournaments"
          />
          <NavItem
            icon={Shield}
            label="CLAN"
            to="/dashboard/clan"
          />
          <NavItem
            icon={Users}
            label="Bảng xếp hạng"
            to="/dashboard/ranking"
          />
        </nav>

        <div className="p-4 border-t border-white/5 relative" ref={userMenuRef}>
          {showUserMenu && (
            <div className="absolute bottom-full left-4 right-4 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden py-2 animate-in slide-in-from-bottom-2 duration-200 z-50">
              <Link
                to="/dashboard/profile"
                className="flex items-center gap-3 px-4 py-3 text-gray-400 hover:text-white hover:bg-white/5 transition-all"
                onClick={() => setShowUserMenu(false)}
              >
                <User size={18} />
                <span className="font-bold text-xs uppercase tracking-widest">Hồ sơ</span>
              </Link>
              <Link
                to="/dashboard/settings"
                className="flex items-center gap-3 px-4 py-3 text-gray-400 hover:text-white hover:bg-white/5 transition-all"
                onClick={() => setShowUserMenu(false)}
              >
                <Settings size={18} />
                <span className="font-bold text-xs uppercase tracking-widest">Cài đặt</span>
              </Link>
              <div className="h-px bg-white/5 my-1 mx-2" />
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-4 py-3 text-red-500/70 hover:text-red-500 hover:bg-red-500/5 transition-all"
              >
                <LogOut size={18} />
                <span className="font-bold text-xs uppercase tracking-widest">Thoát</span>
              </button>
            </div>
          )}

          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            disabled={!profile}
            className={`w-full flex items-center gap-3 p-2 rounded-2xl transition-all hover:bg-white/5 ${showUserMenu ? 'bg-white/5' : ''} ${!profile ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className="w-16 h-12 rounded-xl bg-gradient-to-tr from-fuchsia-600 to-purple-600 p-[1.5px] min-w-[40px]">
              <div className="w-full h-full rounded-xl bg-neutral-950 p-0.5">
                {profile ? (
                  <img
                    src={profile?.avatar_url || "https://api.dicebear.com/7.x/avataaars/svg?seed=fallback"}
                    alt="Avatar"
                    className="w-full h-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="w-full h-full rounded-lg bg-neutral-800 animate-pulse" />
                )}
              </div>
            </div>
            <div className="hidden md:flex flex-col items-start overflow-hidden w-full">
              {profile ? (
                <>
                  <span className="font-black text-sm uppercase tracking-widest text-white truncate w-full text-left">
                    {profile?.display_name || "Chiến Binh"}
                  </span>
                  <span
                    className="text-[9px] font-black uppercase tracking-tighter"
                    style={{ color: rankInfo.color }}
                  >
                    {rankInfo.tier} {rankInfo.division}
                  </span>
                </>
              ) : (
                <>
                  <div className="h-4 w-24 bg-neutral-800 rounded animate-pulse mb-1" />
                  <div className="h-2 w-16 bg-neutral-800 rounded animate-pulse" />
                </>
              )}
            </div>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-black relative custom-scrollbar overflow-y-auto" ref={mainContentRef}>
        {/* Header / Top Bar */}
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-8 sticky top-0 bg-black/80 backdrop-blur-md z-40">
          <div className="flex-1 max-w-xl relative" ref={searchRef}>
            <div className="relative group py-4">
              <Search
                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-fuchsia-500 transition-colors"
                size={18}
              />
              <input
                type="text"
                placeholder="Tìm kiếm người chơi..."
                className="w-1/2 bg-neutral-900/50 border border-white/5 rounded-2xl py-2.5 pl-12 pr-4 text-sm font-medium focus:outline-none focus:border-fuchsia-500/50 focus:bg-neutral-900 transition-all placeholder:text-gray-600"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSearchResults(true);
                }}
                onFocus={() => setShowSearchResults(true)}
              />
            </div>

            {/* Search Results Dropdown */}
            {showSearchResults && (searchQuery.length >= 3 || isSearching) && (
              <div className="absolute top-full left-0 w-1/2 right-0 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="p-2">
                  {isSearching ? (
                    <div className="p-8 flex items-center justify-center gap-3 text-gray-500">
                      <Loader2 className="animate-spin" size={20} />
                      <span className="text-sm font-bold uppercase tracking-widest">
                        Đang truy xuất dữ liệu...
                      </span>
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="space-y-1">
                      {searchResults.map((player) => (
                        <Link
                          key={player.id}
                          to={`/dashboard/profile?id=${player.id}`}
                          onClick={() => setShowSearchResults(false)}
                          className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors group"
                        >
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <div className="w-10 h-10 rounded-full border-2 border-fuchsia-500/20 p-0.5">
                                <img
                                  src={player.avatar_url || undefined}
                                  alt={player.display_name || ""}
                                  className="w-full h-full rounded-full object-cover border-2 border-black"
                                />
                              </div>
                            </div>
                            <div>
                              <div className="font-bold text-sm text-white group-hover:text-fuchsia-400 transition-colors">
                                {player.display_name}
                              </div>
                              <div className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">
                                {player.email}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-fuchsia-500 bg-fuchsia-500/10 px-2 py-1 rounded-lg border border-fuchsia-500/20">
                              {player.mmr ?? 0} MMR
                            </span>
                            <ChevronRight
                              size={16}
                              className="text-gray-700 group-hover:text-fuchsia-500 transition-colors"
                            />
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-gray-500">
                      <p className="text-sm font-bold uppercase tracking-widest">
                        Không tìm thấy thực thể nào
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Center: Lobby Button - Tech Hub Hanging from top */}
          <div className="absolute left-1/2 -translate-x-1/2 top-0 h-full hidden lg:flex items-start">
            <Link
              to="/dashboard/arena"
              className="relative group transition-all duration-300 pointer-events-auto"
            >
              {/* Outer Glow */}
              <div className="absolute -inset-4 bg-fuchsia-500/10 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity rounded-full bg-fuchsia-600/20" />
              
              <div 
                className="bg-neutral-900 border-x border-b border-fuchsia-500/30 px-24 pb-3 pt-5 relative group-hover:border-fuchsia-400 overflow-hidden transition-all active:translate-y-0.5"
                style={{
                  clipPath: 'polygon(0 0, 100% 0, 85% 100%, 15% 100%)'
                }}
              >
                {/* Background Tech Tint */}
                <div className="absolute inset-0 bg-fuchsia-500/5 group-hover:bg-fuchsia-500/10 transition-colors" />
                
                {/* Content */}
                <div className="flex flex-col items-center gap-1 relative z-10">
                   <div className="p-1 rounded bg-fuchsia-500/10 border border-fuchsia-500/20 group-hover:bg-fuchsia-600 group-hover:border-fuchsia-400 transition-all duration-300">
                      <Swords size={14} className="text-fuchsia-400 group-hover:text-white transition-colors" />
                   </div>
                   <span className="font-black text-[10px] uppercase tracking-[0.4em] text-fuchsia-500 group-hover:text-fuchsia-300 group-hover:drop-shadow-[0_0_8px_#d946ef] transition-all">
                     Sảnh chính
                   </span>
                </div>

                {/* Scanline Ornament */}
                <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-fuchsia-400 to-transparent opacity-50" />
                
                {/* Cyber Scanline Loop */}
                <div className="absolute inset-0 pointer-events-none opacity-20 group-hover:opacity-40 transition-opacity">
                    <div className="w-full h-[200%] bg-[linear-gradient(to_bottom,transparent_0,rgba(217,70,239,0.2)_50%,transparent_100%)] animate-scanline-fast" />
                </div>
              </div>
              
              {/* Corner Accents */}
            </Link>
          </div>

          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2 bg-neutral-900/50 border border-white/5 px-4 py-2 rounded-2xl transition-all group min-w-[120px]">
              <div className="w-8 h-8 rounded-full bg-yellow-500/10 flex items-center justify-center border border-yellow-500/20 transition-all">
                <Coins size={16} className="text-yellow-500" />
              </div>
              {profile ? (
                <span className="font-black text-xs text-white tabular-nums">{profile?.balance?.toLocaleString() || 0}</span>
              ) : (
                <div className="h-4 w-12 bg-neutral-800 rounded animate-pulse" />
              )}
              <Link to="/dashboard/payment" className="w-6 h-6 rounded-full bg-fuchsia-500 ml-4 hover:bg-fuchsia-400 flex items-center justify-center transition-all shadow-[0_0_15px_rgba(217,70,239,0.3)] hover:shadow-[0_0_25px_rgba(217,70,239,0.5)] active:scale-95 text-black">
                <Plus size={12} strokeWidth={4} />
              </Link>
            </div>
          </div>
        </header>

        {/* Dynamic Route Content */}
        <div className="flex-1 p-8">
          <Outlet context={{ user, profile, setProfile, dashboardCache, setDashboardCache, showToast }} />
        </div>
        
        {toast.visible && (
          <Toast 
            message={toast.message} 
            type={toast.type} 
            onClose={() => setToast(prev => ({ ...prev, visible: false }))} 
          />
        )}
      </main>
    </div>
  );
};

const NavItem = ({
  icon: Icon,
  label,
  to,
}: {
  icon: ElementType;
  label: string;
  to: string;
}) => (
  <NavLink
    to={to}
    end
    className={({ isActive }) =>
      `flex items-center gap-3 px-4 py-3 transition-all group relative overflow-hidden ${
        isActive
          ? "text-white"
          : "text-gray-400 hover:text-white"
      }`
    }
    style={({ isActive }) => ({
      clipPath: isActive ? 'polygon(0 0, 100% 0, 95% 100%, 0% 100%)' : 'none'
    })}
  >
    {({ isActive }) => (
      <>
        {/* Active/Hover Background */}
        {isActive && (
          <div className="absolute inset-0 bg-fuchsia-600/20 border-l-2 border-fuchsia-500 z-0">
            {/* Cyber Scanline Loop */}
            <div className="absolute inset-0 pointer-events-none opacity-20">
                <div className="w-full h-[200%] bg-[linear-gradient(to_bottom,transparent_0,rgba(217,70,239,0.3)_50%,transparent_100%)] animate-scanline-fast" />
            </div>
            {/* Glow */}
            <div className="absolute inset-0 shadow-[0_0_20px_rgba(192,38,211,0.2)]" />
          </div>
        )}
        
        {/* Hidden Hover State (Simple tint) */}
        {!isActive && (
          <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors z-0" />
        )}

        <Icon size={20} className={`relative z-10 transition-all ${isActive ? "text-fuchsia-400 drop-shadow-[0_0_8px_rgba(217,70,239,0.5)]" : "group-hover:text-white"}`} />
        <span className="hidden md:block font-black text-[11px] uppercase tracking-widest relative z-10">
          {label}
        </span>

        {/* HUD Decoration for Active */}
        {isActive && (
          <div className="absolute top-0 right-0 p-1 opacity-50">
            <div className="w-1.5 h-1.5 border-t border-r border-fuchsia-400" />
          </div>
        )}
      </>
    )}
  </NavLink>
);

export default DashboardPage;
