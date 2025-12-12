import pandas as pd
import json
import time
import os
import requests
from nba_api.stats.endpoints import leaguegamefinder, shotchartdetail
from nba_api.stats.static import teams
import pbpstats
from pbpstats.client import Client

# Custom headers
custom_headers = {
    'Host': 'stats.nba.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.nba.com/',
    'Origin': 'https://www.nba.com',
    'Connection': 'keep-alive',
    'x-nba-stats-origin': 'stats',
    'x-nba-stats-token': 'true'
}

# Override pbpstats headers just in case
pbpstats.HEADERS.clear()
pbpstats.HEADERS.update(custom_headers)

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)
PBP_CACHE_DIR = os.path.join(DATA_DIR, "pbp_cache")
os.makedirs(PBP_CACHE_DIR, exist_ok=True)
os.makedirs(os.path.join(PBP_CACHE_DIR, "pbp"), exist_ok=True)
os.makedirs(os.path.join(PBP_CACHE_DIR, "game_details"), exist_ok=True)

def get_lakers_games():
    print("Fetching Lakers games...")
    lakers_id = teams.find_teams_by_full_name('Los Angeles Lakers')[0]['id']
    gamefinder = leaguegamefinder.LeagueGameFinder(team_id_nullable=lakers_id, headers=custom_headers)
    games = gamefinder.get_data_frames()[0]
    
    # Filter for 2024-25 Regular Season
    games_2425 = games[games['SEASON_ID'] == '22024']
    print(f"Found {len(games_2425)} games.")
    return games_2425, lakers_id

def get_shots(game_id, team_id):
    print(f"Fetching shots for game {game_id}...")
    try:
        shots = shotchartdetail.ShotChartDetail(
            team_id=team_id,
            player_id=0,
            game_id_nullable=game_id,
            context_measure_simple='FGA',
            headers=custom_headers,
            timeout=30
        ).get_data_frames()[0]
        return shots
    except Exception as e:
        print(f"Error fetching shots: {e}")
        return pd.DataFrame()

def get_pbp_lineups(game_id):
    print(f"Fetching PBP lineups for game {game_id}...")
    settings = {
        "dir": PBP_CACHE_DIR,
        "Possessions": {"source": "web", "data_provider": "data_nba"},
        "EnhancedPbp": {"source": "web", "data_provider": "data_nba"},
    }
    try:
        client = Client(settings)
        game = client.Game(game_id)
        
        # Create a lookup: event_num -> {team_id: [player_ids]}
        lineup_lookup = {}
        
        if hasattr(game, 'enhanced_pbp'):
            for event in game.enhanced_pbp.items:
                # Store current players for this event
                # event.current_players is {team_id: [player_ids]}
                lineup_lookup[event.event_num] = event.current_players
                
        return lineup_lookup
    except Exception as e:
        print(f"Error fetching PBP: {e}")
        return {}

def process_game(game_row, lakers_id):
    game_id = game_row['GAME_ID']
    matchup = game_row['MATCHUP']
    game_date = game_row['GAME_DATE']
    
    print(f"Processing {matchup} ({game_id})...")
    
    # 1. Get Shots
    time.sleep(1)
    shots_df = get_shots(game_id, lakers_id)
    if shots_df.empty:
        return []
        
    # 2. Get Lineups
    time.sleep(1)
    lineup_lookup = get_pbp_lineups(game_id)
    
    processed_shots = []
    
    for _, shot in shots_df.iterrows():
        event_id = shot['GAME_EVENT_ID']
        
        # Find lineup
        # Note: Shot event ID might not match exactly with PBP event ID if sources differ
        # But usually they are close or match.
        # Let's try exact match first.
        
        # pbpstats events have 'event_num' which corresponds to GAME_EVENT_ID
        
        current_players = lineup_lookup.get(event_id)
        
        teammates = []
        opponents = []
        
        if current_players:
            # Identify Lakers vs Opponent
            # lakers_id is int, keys in current_players might be int
            
            for team_id, players in current_players.items():
                if int(team_id) == int(lakers_id):
                    teammates = players
                else:
                    opponents = players
        else:
            # Fallback: try to find nearest event?
            # For now, just leave empty or mark as missing
            pass
            
        shot_data = shot.to_dict()
        shot_data['teammates_on_court'] = teammates
        shot_data['opponents_on_court'] = opponents
        
        processed_shots.append(shot_data)
        
    return processed_shots

def main():
    games, lakers_id = get_lakers_games()
    
    all_shots = []
    
    # Process all games
    for _, game in games.iterrows():
        game_shots = process_game(game, lakers_id)
        all_shots.extend(game_shots)
        
    output_file = "lakers_shots_2024_25.json"
    with open(output_file, "w") as f:
        json.dump(all_shots, f, indent=2)
        
    print(f"Saved {len(all_shots)} shots to {output_file}")

if __name__ == "__main__":
    main()
