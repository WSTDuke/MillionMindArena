import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TOURNAMENT_CONFIG } from '../../../lib/constants';

interface MatchMonitorProps {
  userClanId: string | undefined;
}

const MatchMonitor = ({ userClanId }: MatchMonitorProps) => {
  const navigate = useNavigate();
  
  // Clear navigation history when component mounts (user returns to dashboard)
  // This allows re-navigation if they come back
  useEffect(() => {
    sessionStorage.removeItem('navigated_matches');
    console.log('[MatchMonitor] Cleared navigation history');
  }, []);
  
  // Debug: Log userClanId changes
  useEffect(() => {
    console.log('[MatchMonitor] userClanId changed:', userClanId);
  }, [userClanId]);
  
  // We use sessionStorage to track which matches we've already auto-navigated to,
  // preventing infinite loops if the user clicks "Back".
  const getNavigatedMatches = () => {
      try {
          return JSON.parse(sessionStorage.getItem('navigated_matches') || '[]');
      } catch { return []; }
  };

  useEffect(() => {
    if (!userClanId) {
      console.log('[MatchMonitor] No userClanId, skipping check');
      return;
    }

    const checkInterval = setInterval(() => {
      const storageKey = `bracket_${TOURNAMENT_CONFIG.ID}_${TOURNAMENT_CONFIG.START_TIME}`;
      const savedBracketStr = localStorage.getItem(storageKey);
      if (!savedBracketStr) {
        console.log('[MatchMonitor] No bracket found in localStorage');
        return;
      }

      const matches = JSON.parse(savedBracketStr);
      const now = new Date().getTime();

      // Find an upcoming or live match for the user's clan
      const myMatch = matches.find((m: { id: string, clan1: any, clan2: any, status: string, scheduledTime: string }) => 
        (m.clan1?.id === userClanId || m.clan2?.id === userClanId) && 
        m.status !== 'completed'
      );

      if (myMatch) {
        const matchStartTime = new Date(myMatch.scheduledTime).getTime();
        const diffSeconds = (matchStartTime - now) / 1000;
        
        console.log('[MatchMonitor] Found match:', {
          matchId: myMatch.id,
          status: myMatch.status,
          scheduledTime: myMatch.scheduledTime,
          diffSeconds: Math.round(diffSeconds),
          now: new Date(now).toISOString()
        });

        // Trigger if match starts in less than 60 seconds or is already live (within 5 minutes)
        // Increased window to ensure we don't miss the match
        if (diffSeconds <= 60 && diffSeconds > -300) {
           const navigated = getNavigatedMatches();
           if (!navigated.includes(myMatch.id)) {
               console.log('[MatchMonitor] Navigating to match:', myMatch.id);
               // Mark as navigated
               sessionStorage.setItem('navigated_matches', JSON.stringify([...navigated, myMatch.id]));
               
               // Navigate
               navigate(`/tournament-match/${myMatch.id}`);
           } else {
               console.log('[MatchMonitor] Already navigated to this match');
           }
        }
      } else {
        console.log('[MatchMonitor] No active match found for clan:', userClanId);
      }
    }, 3000); // Check every 3 seconds (more frequent)

    return () => clearInterval(checkInterval);
  }, [userClanId, navigate]);

  return null;
};

export default MatchMonitor;
