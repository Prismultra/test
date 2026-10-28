extends Node3D
## Keeps score, runs the timer, and restarts the level once every coin is collected.

@onready var score_label: Label = $HUD/ScoreLabel
@onready var win_label: Label = $HUD/WinLabel

var _total_coins := 0
var _collected := 0
var _elapsed := 0.0
var _finished := false


func _ready() -> void:
	# Any node in the "coins" group counts, so you can add more coins in the editor.
	var coins := get_tree().get_nodes_in_group("coins")
	_total_coins = coins.size()
	for coin in coins:
		coin.connect("collected", _on_coin_collected)
	_update_hud()


func _process(delta: float) -> void:
	if not _finished:
		_elapsed += delta
		_update_hud()


func _on_coin_collected() -> void:
	_collected += 1
	_update_hud()
	if _collected >= _total_coins:
		_finished = true
		win_label.text = "All coins collected!\n%.1f seconds" % _elapsed
		win_label.show()
		await get_tree().create_timer(4.0).timeout
		get_tree().reload_current_scene()


func _update_hud() -> void:
	score_label.text = "Coins: %d / %d\nTime: %.1f" % [_collected, _total_coins, _elapsed]
