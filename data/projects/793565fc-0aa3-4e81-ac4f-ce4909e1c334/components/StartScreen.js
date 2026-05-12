import React from 'react';

const StartScreen = ({ setState, gameOver }) => {
  return (
    <div>
      {gameOver ? (
        <h1>Game Over</h1>
      ) : (
        <h1>Welcome to DarkSpaceChess</h1>
      )}
      <button onClick={() => setState('PLAYING')}>Play</button>
      <button onClick={() => console.log('Options')}>Options</button>
      <button onClick={() => console.log('Quit')}>Quit</button>
    </div>
  );
};

export default StartScreen;