//! Admission barrier shared by RPCs and background sync. The second flag check
//! closes the gap between observing idle and incrementing the activity count.
use super::*;
pub(crate) struct Operation<'a>(&'a AppState);
impl Drop for Operation<'_> {
    fn drop(&mut self) { self.0.updates_active_operations.fetch_sub(1, Ordering::SeqCst); }
}
pub(crate) fn begin(state:&AppState)->Result<Operation<'_>,String> {
    let blocked=||"正在准备更新，请等待或取消更新后重试 / An update is being applied; wait or cancel it before starting another operation".to_string();
    if state.updates_installing.load(Ordering::SeqCst) { return Err(blocked()); }
    state.updates_active_operations.fetch_add(1,Ordering::SeqCst);
    let guard=Operation(state);
    if state.updates_installing.load(Ordering::SeqCst) { drop(guard); return Err(blocked()); }
    Ok(guard)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn active_operation_is_counted_until_drop_and_install_blocks_admission() {
        let state=AppState::default();
        { let _guard=begin(&state).unwrap();assert_eq!(state.updates_active_operations.load(Ordering::SeqCst),1); }
        assert_eq!(state.updates_active_operations.load(Ordering::SeqCst),0);
        state.updates_installing.store(true,Ordering::SeqCst);assert!(begin(&state).is_err());
        assert_eq!(state.updates_active_operations.load(Ordering::SeqCst),0);
        state.updates_installing.store(false,Ordering::SeqCst);assert!(begin(&state).is_ok());
    }
}
