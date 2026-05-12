import React from 'react';

const PauseMenu = ({ setState }) => {
  return (
    <div>
      <h1>Pause Menu</h1>
      <button onClick={() => setState('PLAYING')}>Resume</button>
      <button onClick={() => setState('MENU')}>Menu</button>
      <button onClick={() => console.log('Quit')}>Quit</button>
    </div>
  );
};

export default PauseMenu;