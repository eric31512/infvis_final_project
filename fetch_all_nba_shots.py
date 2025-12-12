"""
Fetch NBA Shot Data for All Teams (2023-24 to 2025-26 Seasons)

Usage:
    python fetch_all_nba_shots.py [--test]
    
Options:
    --test    Only fetch 3 games for testing
"""

import pandas as pd
import json
import time
import os
import sys
import argparse
from datetime import datetime
from nba_api.stats.endpoints import leaguegamefinder, shotchartdetail
from nba_api.stats.static import teams
import pbpstats
from pbpstats.client import Client

# Custom headers to mimic browser
CUSTOM_HEADERS = {
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

# Override pbpstats headers
pbpstats.HEADERS.clear()
pbpstats.HEADERS.update(CUSTOM_HEADERS)

# Configuration
SEASONS = ["2023-24", "2024-25"]  # 2025-26 will be added when available
SEASON_IDS = {"2023-24": "22023", "2024-25": "22024", "2025-26": "22025"}
REQUEST_DELAY = 1.5  # seconds between API calls
BATCH_REST_INTERVAL = 50  # games before taking a longer break
BATCH_REST_DURATION = 30  # seconds for batch rest

DATA_DIR = "data"
OUTPUT_DIR = os.path.join(DATA_DIR, "shots_by_season")
PBP_CACHE_DIR = os.path.join(DATA_DIR, "pbp_cache")
PROGRESS_FILE = os.path.join(DATA_DIR, "progress.json")


def setup_dirs():
    """Create necessary directories."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(PBP_CACHE_DIR, exist_ok=True)
    os.makedirs(os.path.join(PBP_CACHE_DIR, "pbp"), exist_ok=True)
    os.makedirs(os.path.join(PBP_CACHE_DIR, "game_details"), exist_ok=True)


def load_progress():
    """Load progress from checkpoint file."""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, 'r') as f:
            return json.load(f)
    return {"completed_games": []}


def save_progress(progress):
    """Save progress to checkpoint file."""
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f, indent=2)


def get_all_teams():
    """Get all NBA teams."""
    all_teams = teams.get_teams()
    return [(t['id'], t['full_name'], t['abbreviation']) for t in all_teams]


def get_team_games(team_id, season_id):
    """Fetch all games for a team in a season."""
    print(f"  Fetching games for team {team_id}, season {season_id}...")
    try:
        gamefinder = leaguegamefinder.LeagueGameFinder(
            team_id_nullable=team_id,
            headers=CUSTOM_HEADERS,
            timeout=60
        )
        games = gamefinder.get_data_frames()[0]
        # Filter by season
        season_games = games[games['SEASON_ID'] == season_id]
        return season_games
    except Exception as e:
        print(f"  Error fetching games: {e}")
        return pd.DataFrame()


def get_shots_with_retry(game_id, team_id, max_retries=3):
    """Fetch shots for a game with retry logic."""
    for attempt in range(max_retries):
        try:
            shots = shotchartdetail.ShotChartDetail(
                team_id=team_id,
                player_id=0,
                game_id_nullable=game_id,
                context_measure_simple='FGA',
                headers=CUSTOM_HEADERS,
                timeout=60
            ).get_data_frames()[0]
            return shots
        except Exception as e:
            wait_time = (2 ** attempt) * 2  # Exponential backoff
            print(f"    Retry {attempt + 1}/{max_retries} after {wait_time}s: {e}")
            time.sleep(wait_time)
    return pd.DataFrame()


def get_pbp_lineups(game_id):
    """Fetch play-by-play lineup data."""
    settings = {
        "dir": PBP_CACHE_DIR,
        "Possessions": {"source": "web", "data_provider": "data_nba"},
        "EnhancedPbp": {"source": "web", "data_provider": "data_nba"},
    }
    try:
        client = Client(settings)
        game = client.Game(game_id)
        
        lineup_lookup = {}
        if hasattr(game, 'enhanced_pbp'):
            for event in game.enhanced_pbp.items:
                lineup_lookup[event.event_num] = event.current_players
        return lineup_lookup
    except Exception as e:
        # PBP data may not be available for all games
        return {}


def process_game(game_row, team_id, season):
    """Process a single game: fetch shots and lineups."""
    game_id = game_row['GAME_ID']
    matchup = game_row['MATCHUP']
    game_date = game_row['GAME_DATE']
    
    print(f"    Processing {matchup} ({game_id})...")
    
    # 1. Get Shots
    time.sleep(REQUEST_DELAY)
    shots_df = get_shots_with_retry(game_id, team_id)
    if shots_df.empty:
        print(f"    No shots data for {game_id}")
        return []
    
    # 2. Get Lineups (optional, don't fail if unavailable)
    time.sleep(REQUEST_DELAY)
    lineup_lookup = get_pbp_lineups(game_id)
    
    processed_shots = []
    
    for _, shot in shots_df.iterrows():
        event_id = shot['GAME_EVENT_ID']
        current_players = lineup_lookup.get(event_id, {})
        
        teammates = []
        opponents = []
        
        if current_players:
            for tid, players in current_players.items():
                if int(tid) == int(team_id):
                    teammates = players
                else:
                    opponents = players
        
        shot_data = shot.to_dict()
        shot_data['teammates_on_court'] = teammates
        shot_data['opponents_on_court'] = opponents
        shot_data['SEASON'] = season
        shot_data['GAME_DATE'] = game_date
        
        processed_shots.append(shot_data)
    
    return processed_shots


def get_team_file_key(season, team_abbr):
    """Get the file key for season+team combination."""
    return f"{season}_{team_abbr}"


def load_team_data(season, team_abbr):
    """Load existing team data from JSON file."""
    filepath = os.path.join(OUTPUT_DIR, f"{season}_{team_abbr}.json")
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            return json.load(f)
    return []


def save_team_data(season, team_abbr, data):
    """Save team data to JSON file (D3.js compatible format)."""
    filepath = os.path.join(OUTPUT_DIR, f"{season}_{team_abbr}.json")
    with open(filepath, 'w') as f:
        json.dump(data, f, default=str)
    print(f"  Saved {len(data)} shots to {filepath}")


# In-memory storage for current team
current_team_data = []


def main():
    parser = argparse.ArgumentParser(description="Fetch NBA shot data")
    parser.add_argument('--test', action='store_true', help='Test mode: only fetch 3 games')
    args = parser.parse_args()
    
    setup_dirs()
    progress = load_progress()
    completed_games = set(progress['completed_games'])
    
    all_teams_list = get_all_teams()
    print(f"Found {len(all_teams_list)} teams")
    
    total_games_processed = 0
    total_shots_fetched = 0
    
    for season in SEASONS:
        season_id = SEASON_IDS.get(season)
        if not season_id:
            continue
            
        print(f"\n{'='*60}")
        print(f"Processing Season: {season}")
        print(f"{'='*60}")
        
        for team_id, team_name, team_abbr in all_teams_list:
            print(f"\n[{team_abbr}] {team_name}")
            
            # Load existing data for this team
            team_shots = load_team_data(season, team_abbr)
            team_games_processed = 0
            
            # Get all games for this team/season
            time.sleep(REQUEST_DELAY)
            games_df = get_team_games(team_id, season_id)
            
            if games_df.empty:
                print(f"  No games found")
                continue
            
            print(f"  Found {len(games_df)} games")
            
            for idx, (_, game) in enumerate(games_df.iterrows()):
                game_id = game['GAME_ID']
                cache_key = f"{game_id}_{team_id}"
                
                # Skip if already processed
                if cache_key in completed_games:
                    print(f"    Skipping {game_id} (already done)")
                    continue
                
                # Process game
                shots = process_game(game, team_id, season)
                
                if shots:
                    team_shots.extend(shots)
                    total_shots_fetched += len(shots)
                
                # Mark as completed
                completed_games.add(cache_key)
                progress['completed_games'] = list(completed_games)
                save_progress(progress)
                
                total_games_processed += 1
                team_games_processed += 1
                print(f"    Got {len(shots)} shots (Total: {total_shots_fetched})")
                
                # Test mode: exit early
                if args.test and total_games_processed >= 3:
                    print("\n[TEST MODE] Stopping after 3 games")
                    print(f"Total games: {total_games_processed}, Total shots: {total_shots_fetched}")
                    save_team_data(season, team_abbr, team_shots)
                    return
                
                # Batch rest
                if total_games_processed % BATCH_REST_INTERVAL == 0:
                    print(f"\n  [Batch rest: {BATCH_REST_DURATION}s after {total_games_processed} games]")
                    time.sleep(BATCH_REST_DURATION)
            
            # Save team data after processing all games for this team
            if team_games_processed > 0:
                save_team_data(season, team_abbr, team_shots)
    
    print(f"\n{'='*60}")
    print(f"COMPLETE!")
    print(f"Total games processed: {total_games_processed}")
    print(f"Total shots fetched: {total_shots_fetched}")
    print(f"Output files in: {OUTPUT_DIR}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
