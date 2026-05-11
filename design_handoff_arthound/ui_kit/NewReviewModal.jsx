/* global React, Modal, Button, Field */
const { useState: useStateNew } = React;

function NewReviewModal({ onClose, onCreate }) {
  const [asset, setAsset] = useStateNew('Hero — Jett · Battlepass IX');
  const [reviewer, setReviewer] = useStateNew('art-direction@studio.gg');
  const [note, setNote] = useStateNew('');
  return (
    <Modal title="New Review" onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onCreate(asset)}>Create Review</Button>
      </>}>
      <Field label="Asset *" value={asset} onChange={e=>setAsset(e.target.value)}/>
      <Field label="Reviewer" value={reviewer} onChange={e=>setReviewer(e.target.value)}/>
      <div className="col gap-1">
        <label className="t-muted t-xs">Note</label>
        <textarea className="input" value={note} onChange={e=>setNote(e.target.value)}
          placeholder="Anything you want the reviewer to focus on?"
          style={{minHeight:84,resize:'vertical',fontFamily:'inherit'}}/>
      </div>
    </Modal>
  );
}

window.NewReviewModal = NewReviewModal;
