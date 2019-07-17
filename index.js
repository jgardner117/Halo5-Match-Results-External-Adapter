var request = require("request");
var apikey = process.env.apikey;


exports.handler = (event, context, callback) => {
  if (event["data"]["matchid"]) {
    //If a matchid was specified in the contract, then only look up the results for that match
    singleMatchResults(event)
      .then(function(matches) {
        //Return results of successful query to contract
        var returnData = {
          statusCode: 200,
          jobRunID: event["id"],
          data: matches,
          status: "completed",
          error: null,
          pending: false
        }
        callback(null, returnData)
      })
      .catch(function(reject) {
        //Return error from unsuccessful query to contract
        callback(reject, null)
      })
  } else {
    //If no matchid is provided, search through the player's last 5 games
    getPlayerMatchHistory(event).then(function([event, matches]) {
        var matchList = []
        for (index in matches) {
          var singlematch = singleMatchResults(event, matches[index])
          matchList.push(singlematch)
        }
        return Promise.all(matchList).then(function(matches) {
          return teamGamertagCompare(matches)
        })
      })
      .then(function(matches) {
        if ((!Array.isArray(matches) || !matches.length)) {
          //Return error from unsuccessful query to contract
          var returnData = {
            statusCode: 400,
            jobRunID: event["id"],
            status: "errored",
            error: "No games found matching the parameters provided",
            pending: false
          }
          callback(returnData, null)
        } else {
          //Return results of successful query to contract
          var returnData = {
            statusCode: 200,
            jobRunID: event["id"],
            data: matches,
            status: "completed",
            error: null,
            pending: false
          }
          callback(null, returnData)
        }
      })
      .catch(function(reject) {
        //here when you reject the promise
        callback(reject, null)
      })
  }
};


function teamGamertagCompare(matches) {
  //Compare the Gamertags from the match returned from singleMatchResults to the
  // teams declared in the smart contract to see if this is the match it references
  var finalmatches = [];
  for (l in matches) {
    //For each match in the array of matches retrived from the last API call
    console.log("this is l " + JSON.stringify(matches[l]["Teams"]))
    var matchfound = 0;
    for (x in matches[l]["TeamsFromContract"]) {
      //For each team in the team array from the event
      for (s in matches[l]["Teams"]) {
        //For each team in the match from the array of matches retrived from the last API call
        let areEqual = matches[l]["Teams"][s]["Members"].length === matches[l]["TeamsFromContract"][x].length && matches[l]["Teams"][s]["Members"].every(item => matches[l]["TeamsFromContract"][x].indexOf(item) > -1);
        /*Compare the two teams and see if they match, meaning this could be
        the Halo match the Smart Contract wanted. If they match, increment the
         match found variable to indicate at least one team matches the teams
         from the Smart Contract*/
        if (areEqual == true) {
          matchfound++
          break
        }
      }
    }
    //If all teams passed by the Smart Contract are found in the match from the API, then add the match info to the finalmatches array
    if (matchfound == Object.keys(matches[l]["TeamsFromContract"]).length) {
      matchfound = 0
      matches[l]["TeamsFromContract"]
      finalmatches.push(matches[l])
      continue
    } else {
      matchfound = 0
    }
  }
  //Finalmatches array contains the final list of matches to pass back to the Smart Contract
  return finalmatches
}

function singleMatchResults(event, match) {
  /*This function is used to look up a single particular match specified by the matchid
  parameter in the Smart Contract and passed via event*/
  return new Promise((resolve, reject) => {
    if (typeof match === 'undefined') {
      //This sets the matchid in the request URL to the matchid from the smart contract, if specified
      var matchid = event["data"]["matchid"];
    } else {
      //Otherwise, use a matchid passed from getPlayerMatchHistory
      var matchid = match[0];
    }
    var url = "https://www.haloapi.com/stats/h5/custom/matches/" + matchid;
    console.log("in singlematchresult " + event)
    let headerObj = {
      "Ocp-Apim-Subscription-Key": apikey
    };
    let options = {
      url: url,
      headers: headerObj
    };
    request(options, function(err, response, body) {
      console.log(response.statusCode)
      var data;
      if (err || response.statusCode > "200") {
        if (!response.statusCode > "200") {
          data = JSON.parse(body)
        } else {
          data = "API error - check request parameters and try again."
        }
        var errorData = {
          statusCode: response.statusCode,
          jobRunID: event["id"],
          data: data,
          status: "errored",
          error: err,
          pending: false
        }
        reject(JSON.parse(JSON.stringify(errorData)));
      } else {
        //Assembles an object with all relevant match stats and info
        var players = [];
        var parsedbody = JSON.parse(body)
        var playerStats = JSON.parse(body).PlayerStats
        Object.keys(playerStats).forEach(function(key) {
          var team = playerStats[key].TeamId
          if (typeof players[team] === 'undefined') {
            players[team] = [];
          }
          players[team].push(playerStats[key].Player.Gamertag)
        });
        var matchinfo = {
          IsMatchOver: parsedbody.IsMatchOver,
          IsTeamGame: parsedbody.IsTeamGame,
          MatchID: matchid,
          TotalDuration: parsedbody.TotalDuration,
          MapId: parsedbody.MapId,
          Winner: "",
          Teams: {}
        }
        if (typeof match != 'undefined') {
          matchinfo["MatchCompleteDate"] = match[1];
          matchinfo["TeamsFromContract"] = event["data"]["players"];
        }
        if (parsedbody.IsMatchOver == false) {
          matchinfo["Winner"] = "Pending"
        }
        Object.keys(players).forEach(function(team, i) {
          var teamname = "Team" + i
          var teamstats = {
            Score: parsedbody.TeamStats[i].Score,
            Rank: parsedbody.TeamStats[i].Rank,
            RoundStats: parsedbody.TeamStats[i].RoundStats
          }
          teamstats["Members"] = players[team]
          matchinfo["Teams"][teamname] = teamstats
          if (teamstats["Rank"] == 1 && matchinfo["Winner"] == "") {
            matchinfo["Winner"] = teamname
          }
        })
        resolve(matchinfo)
      };
    })
  })
}



function getPlayerMatchHistory(event) {
  /*This function uses the Player Match History endpoint to return a list of all
   game ids that the player participated in on the given day in the given game mode*/
  return new Promise((resolve, reject) => {
    //Set up the object to pass back in case of an error, formatted properly for Chainlink
    var errorData = {
      statusCode: 400,
      jobRunID: event["id"],
      data: "",
      status: "errored",
      error: null,
      pending: false
    }
    //Gamertag associated with the contract
    const gamertag = event["data"].gamertag
    if (!gamertag) {
      errorData.data = "gamertag parameter needed to search for games if matchid parameter is not used"
      reject(JSON.parse(JSON.stringify(errorData)));
    }
    //Game mode to pull match history of (custom or customlocal supported currently)
    const gamemode = event["data"].gamemode
    if (gamemode == "custom" || gamemode == "customlocal") {
      var url = "https://www.haloapi.com/stats/h5/players/" + gamertag + "/matches?modes=" + gamemode;
    } else {
      errorData.data = "gamemode parameter needs to be custom or customlocal to indicate which network/lobby type the game was played in"
      reject(JSON.parse(JSON.stringify(errorData)));
    }
    //The ISO8601 style date that the match was completed on
    try {
      var gamedate = new Date(event["data"].gamedate)
      console.log(gamedate.toISOString())
    } catch (err) {
      gamedate = null
      errorData.data = "gamedate needs to be a valid date that can be turned into an ISO8601 style date"
      console.log(errorData.data)
      reject(JSON.parse(JSON.stringify(errorData)));
    }
    let headerObj = {
      "Ocp-Apim-Subscription-Key": apikey
    };
    let options = {
      url: url,
      headers: headerObj
    };
    request(options, function(err, response, body) {
      console.log(response.statusCode)
      var data;
      if (err || response.statusCode > "200") {
        if (!response.statusCode > "200") {
          data = JSON.parse(body)
        } else {
          data = "API error - check request parameters and try again."
        }
        errorData = {
          statusCode: response.statusCode,
          jobRunID: event["id"],
          data: data,
          status: "errored",
          error: err,
          pending: false
        }
        reject(JSON.parse(JSON.stringify(errorData)));
      } else {
        //Create an object with the game ids and game dates that match the query
        var dates = [];
        var parsedbody = JSON.parse(body).Results
        /*Compare the game's date returned from the API to the dat specified in the contract
        if date matches, add it to the list of potential games to compare gamertags to*/
        if (gamedate != null) {
          Object.keys(parsedbody).forEach(function(key) {
            var g = new Date(parsedbody[key].MatchCompletedDate.ISO8601Date)
            if (g.toISOString() === gamedate.toISOString()) {
              console.log("api gdate" + g.toISOString())
              dates.push([parsedbody[key].Id.MatchId, parsedbody[key].MatchCompletedDate.ISO8601Date])
            } else {
              console.log("MatchCompletedDate.ISO8601Date != gamedate from contract")
            }
          });
        }
        //Slice the list of games down to only 5
        if (dates.length > 5) {
          dates = dates.slice(0, 5)
          console.log("this is length " + dates)
        }
        resolve([event, dates])
      };
    })

  })
}
