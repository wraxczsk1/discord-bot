local apiURL = "http://TVŮJ_SERVER:3000/log" -- sem půjde tvůj bot

function sendToBot(title, message, color)
    PerformHttpRequest(apiURL, function() end, "POST", json.encode({
        title = title,
        message = message,
        color = color,
        server = "Renux RP"
    }), { ["Content-Type"] = "application/json" })
end

-- ITEM PŘIDÁN
AddEventHandler("esx:addInventoryItem", function(playerId, item, count)
    local xPlayer = ESX.GetPlayerFromId(playerId)
    sendToBot(
        "Inventář – Přidáno",
        ("**%s** získal **%s x%d**"):format(xPlayer.getName(), item, count),
        3066993
    )
end)

-- ITEM ODEBRÁN
AddEventHandler("esx:removeInventoryItem", function(playerId, item, count)
    local xPlayer = ESX.GetPlayerFromId(playerId)
    sendToBot(
        "Inventář – Odebráno",
        ("**%s** přišel o **%s x%d**"):format(xPlayer.getName(), item, count),
        15158332
    )
end)
